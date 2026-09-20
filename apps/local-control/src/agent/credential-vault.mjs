import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * Replaces a vault file in one step.
 *
 * Writing over the vault in place is a way to lose every credential at once:
 * `writeFileSync` truncates first, so a crash, a full disk, or a second
 * process writing concurrently leaves a half-written file, and the next read
 * fails to parse — with no copy of the old contents anywhere. The temporary
 * file is created 0600 from the start (never 0644 then chmod, which is a
 * window where the file is readable), flushed, and renamed over the target,
 * which is atomic within a filesystem.
 */
function writeFileAtomically(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  let handle = null;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeSync(handle, contents, null, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    renameSync(temporary, path);
  } catch (error) {
    if (handle !== null) closeSync(handle);
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Where a vault file lives when the caller names no path.
 *
 * Absolute, and on the same `~/.atlas` the rest of the daemon uses. A
 * relative default resolved against the working directory, so a credential
 * stored by the daemon started from one directory was simply missing when it
 * was started from another — presenting as an empty vault rather than as an
 * error, which is the worst way for this to fail.
 */
export function defaultVaultPath(fileName, home = homedir()) {
  return join(process.env.ATLAS_LOCAL_DATA_DIR || join(home, ".atlas"), fileName);
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
      /**
       * Stored without the secret ever appearing in this process's arguments.
       *
       * `security add-generic-password -w <value>` puts the credential in
       * argv, where every other process running as this user can read it out
       * of the process list for as long as the call takes. `security -i`
       * takes the same command on standard input instead, which is not
       * listed anywhere.
       *
       * The stdin form is confirmed by reading the credential back rather
       * than assumed: `security`'s interactive parser is not something to
       * take on faith across macOS versions, and a vault write that silently
       * did nothing is worse than one that used the visible path. So a
       * failed read-back falls back to the argument form, which is a real
       * exposure but a bounded one, and still stores the credential.
       */
      async set(name, value) {
        // `-U` updates in place so repeated rotation does not pile up entries.
        const command = `add-generic-password -a ${quoteForSecurity(name)} -s ${quoteForSecurity(service)} -w ${quoteForSecurity(value)} -U\n`;
        const viaStdin = await runCommandImpl("security", ["-i"], { timeoutMs: 15_000, input: command });
        if (viaStdin.ok && (await keychain().get(name)) === value) return;

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

  /**
   * Quotes one argument for `security -i`, whose parser understands double
   * quotes and backslash escapes. Only those two characters need escaping;
   * a newline inside the quotes would end the command early, so it is
   * refused rather than encoded — a credential does not contain one.
   */
  function quoteForSecurity(text) {
    if (/[\r\n]/u.test(text)) throw new VaultError("INVALID_VALUE", "A credential cannot contain a line break.");
    return `"${text.replace(/([\\"])/gu, "\\$1")}"`;
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
    const path = filePath ?? defaultVaultPath("credentials.dpapi.json");
    const readAll = () => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
    const writeAll = (value) => { writeFileAtomically(path, JSON.stringify(value)); };
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
        // The blob arrives on standard input, matching `set`. Interpolating
        // it into the command text made the credential's length the command
        // line's length, which has a ceiling, and put a value under someone
        // else's control into a string PowerShell then parses.
        const result = await runCommandImpl("powershell", ["-NoProfile", "-NonInteractive", "-Command",
          "$s = ConvertTo-SecureString -String ([Console]::In.ReadToEnd().Trim()); " +
          "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"],
          { timeoutMs: 20_000, input: all[name] });
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
      writeFileAtomically(path, JSON.stringify(encryptBackup(value, passphrase)));
    };
    return {
      async set(name, value) { const all = read(); all[name] = value; write(all); },
      async get(name) { return read()[name] ?? null; },
      async list() { return Object.keys(read()); },
      async delete(name) { const all = read(); delete all[name]; write(all); },
    };
  }
}
