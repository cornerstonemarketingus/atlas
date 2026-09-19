import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";

import { runCommand } from "./tools/process.mjs";
import { decryptBackup, encryptBackup } from "../encrypted-backup.mjs";

/**
 * Where infrastructure credentials live.
 *
 * The operating system's own vault is used when there is one — DPAPI on
 * Windows, Keychain on macOS, libsecret on Linux — and an scrypt+AES-256-GCM
 * file is the fallback. Whichever backs it, the contract is the same and it
 * is the important part: a value goes in, and it never comes back out to
 * anything the model can see. `list()` returns names. `get()` exists for the
 * adapters that must actually make an authenticated request, and no tool
 * result, prompt, receipt or error is allowed to carry what it returns.
 */
export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;

export function assertCredentialName(name) {
  if (!NAME_PATTERN.test(name ?? "")) {
    throw new VaultError("INVALID_NAME", "A credential name must be 3-64 characters of A-Z, 0-9 and underscore.");
  }
  return name;
}

/** Keychain / libsecret / DPAPI, chosen by platform, with a file fallback. */
export function detectVaultBackend(osPlatform = platform()) {
  if (osPlatform === "win32") return "dpapi";
  if (osPlatform === "darwin") return "keychain";
  if (osPlatform === "linux") return "libsecret";
  return "file";
}

export function createCredentialVault({
  backend = detectVaultBackend(),
  filePath = null,
  passphrase = process.env.ATLAS_VAULT_PASSPHRASE ?? null,
  service = "atlas-operator",
  runCommandImpl = runCommand,
} = {}) {
  const store = {
    async set(name, value) {
      assertCredentialName(name);
      if (typeof value !== "string" || value.length === 0) throw new VaultError("EMPTY_VALUE", "A credential value cannot be empty.");
      await backendFor(backend).set(name, value);
      return { name, stored: true };
    },
    async get(name) {
      assertCredentialName(name);
      return backendFor(backend).get(name);
    },
    async has(name) {
      return (await store.get(name)) !== null;
    },
    /** Names and metadata only. There is no path from here to a value. */
    async list() {
      const names = await backendFor(backend).list();
      return names.sort().map((name) => ({ name, backend }));
    },
    async delete(name) {
      assertCredentialName(name);
      await backendFor(backend).delete(name);
      return { name, deleted: true };
    },
    backend,
  };
  return store;

  function backendFor(kind) {
    if (kind === "keychain") return keychain();
    if (kind === "libsecret") return libsecret();
    if (kind === "dpapi") return dpapi();
    return fileVault();
  }

  function keychain() {
    return {
      async set(name, value) {
        // `-w` with the value as an argument is unavoidable for this tool;
        // `-U` updates in place so repeated rotation does not pile up entries.
        const result = await runCommandImpl("security", ["add-generic-password", "-a", name, "-s", service, "-w", value, "-U"], { timeoutMs: 15_000 });
        if (!result.ok) throw new VaultError("VAULT_WRITE_FAILED", `Keychain refused the credential: ${result.stderr.trim()}`);
      },
      async get(name) {
        const result = await runCommandImpl("security", ["find-generic-password", "-a", name, "-s", service, "-w"], { timeoutMs: 15_000 });
        return result.ok ? result.stdout.replace(/\n$/u, "") : null;
      },
      async list() {
        const result = await runCommandImpl("security", ["dump-keychain"], { timeoutMs: 30_000, maxBytes: 4_000_000 });
        if (!result.ok) return [];
        return [...result.stdout.matchAll(/"acct"<blob>="([^"]+)"/gu)].map((match) => match[1]).filter((name) => NAME_PATTERN.test(name));
      },
      async delete(name) {
        await runCommandImpl("security", ["delete-generic-password", "-a", name, "-s", service], { timeoutMs: 15_000 });
      },
    };
  }

  function libsecret() {
    return {
      async set(name, value) {
        const result = await runCommandImpl("secret-tool", ["store", "--label", `${service}:${name}`, "service", service, "account", name], { timeoutMs: 15_000, input: value });
        if (!result.ok) throw new VaultError("VAULT_WRITE_FAILED", `The system keyring refused the credential: ${result.stderr.trim()}`);
      },
      async get(name) {
        const result = await runCommandImpl("secret-tool", ["lookup", "service", service, "account", name], { timeoutMs: 15_000 });
        return result.ok && result.stdout.length > 0 ? result.stdout.replace(/\n$/u, "") : null;
      },
      async list() {
        const result = await runCommandImpl("secret-tool", ["search", "--all", "service", service], { timeoutMs: 20_000 });
        if (!result.ok) return [];
        return [...result.stdout.matchAll(/account = (\S+)/gu)].map((match) => match[1]).filter((name) => NAME_PATTERN.test(name));
      },
      async delete(name) {
        await runCommandImpl("secret-tool", ["clear", "service", service, "account", name], { timeoutMs: 15_000 });
      },
    };
  }

  /**
   * Windows DPAPI, through PowerShell. The ciphertext is bound to the user
   * account, so a copied file is useless on another machine.
   */
  function dpapi() {
    const path = filePath ?? "atlas-credentials.dpapi.json";
    const readAll = () => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
    const writeAll = (value) => { writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 }); };
    return {
      async set(name, value) {
        const result = await runCommandImpl("powershell", ["-NoProfile", "-NonInteractive", "-Command",
          "$v = [Console]::In.ReadToEnd(); ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $v -AsPlainText -Force)"],
          { timeoutMs: 20_000, input: value });
        if (!result.ok) throw new VaultError("VAULT_WRITE_FAILED", "DPAPI refused to protect the credential.");
        const all = readAll();
        all[name] = result.stdout.trim();
        writeAll(all);
      },
      async get(name) {
        const all = readAll();
        if (!all[name]) return null;
        const result = await runCommandImpl("powershell", ["-NoProfile", "-NonInteractive", "-Command",
          `$s = ConvertTo-SecureString -String '${all[name].replace(/'/gu, "''")}'; ` +
          "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"],
          { timeoutMs: 20_000 });
        return result.ok ? result.stdout.replace(/\r?\n$/u, "") : null;
      },
      async list() { return Object.keys(readAll()); },
      async delete(name) { const all = readAll(); delete all[name]; writeAll(all); },
    };
  }

  function fileVault() {
    const path = filePath;
    if (!path) throw new VaultError("NO_VAULT", "A file-backed vault needs a path.");
    const read = () => {
      if (!existsSync(path)) return {};
      if (!passphrase) throw new VaultError("VAULT_LOCKED", "Set ATLAS_VAULT_PASSPHRASE to unlock the credential vault.");
      return decryptBackup(JSON.parse(readFileSync(path, "utf8")), passphrase);
    };
    const write = (value) => {
      if (!passphrase) throw new VaultError("VAULT_LOCKED", "Set ATLAS_VAULT_PASSPHRASE to unlock the credential vault.");
      writeFileSync(path, JSON.stringify(encryptBackup(value, passphrase)), { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    };
    return {
      async set(name, value) { const all = read(); all[name] = value; write(all); },
      async get(name) { return read()[name] ?? null; },
      async list() { return Object.keys(read()); },
      async delete(name) { const all = read(); delete all[name]; write(all); },
    };
  }
}
