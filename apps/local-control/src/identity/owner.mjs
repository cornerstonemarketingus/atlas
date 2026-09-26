import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, platform, userInfo } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Local identity: the owner of a local Atlas is the operating-system account
 * that runs it. No GitHub (or any other) account is involved.
 *
 * - The owner token is kept in that account's own vault (Windows DPAPI, the
 *   macOS Keychain, or the Linux Secret Service), so only the same OS user can
 *   read it. Where no vault works, it falls back to a 0600 file in the data
 *   directory, which is what Atlas always did.
 * - An existing plaintext token file is moved into the vault and removed, so
 *   upgrading does not change the token.
 * - Signing in to the local app needs no copy-paste: `atlas open` (or the
 *   daemon itself with ATLAS_OPEN_BROWSER=1) reads the token as that OS user
 *   and opens the app with it in the URL fragment, which browsers never send to
 *   a server; the page stores it for the tab and removes it from the address.
 *   Being able to read the token is the proof of being the OS account.
 * - ATLAS_LOCAL_TOKEN still overrides everything (services, tests), and
 *   ATLAS_OWNER_TOKEN_STORAGE=file forces the file.
 */

export const OWNER_TOKEN_NAME = "ATLAS_OWNER_TOKEN";
const TOKEN_FILE = "local-token";

export function ownerAccount({ info = safeUserInfo(), host = hostname(), os = platform() } = {}) {
  return { kind: "os-account", user: info?.username ?? "owner", host, platform: os };
}

function safeUserInfo() {
  try { return userInfo(); } catch { return null; }
}

/** Which vault to try: none when forced to file or when Linux has no session bus to reach a keyring. */
export function vaultUsable({ vault, env = process.env, os = platform() }) {
  if (!vault || vault.backend === "file") return false;
  if (String(env.ATLAS_OWNER_TOKEN_STORAGE ?? "").toLowerCase() === "file") return false;
  if (os === "linux" && !env.DBUS_SESSION_BUS_ADDRESS) return false;
  return true;
}

/**
 * @param {{ dataDirectory: string, vault?: { backend: string, get: (name: string) => Promise<string|null>, set: (name: string, value: string) => Promise<unknown> } | null,
 *   env?: Record<string, string|undefined>, os?: string, log?: (line: string) => void }} options
 * @returns {Promise<{ token: string, storage: string, created: boolean }>}
 */
export async function resolveOwnerToken({ dataDirectory, vault = null, env = process.env, os = platform(), log = () => {} }) {
  if (env.ATLAS_LOCAL_TOKEN) return { token: env.ATLAS_LOCAL_TOKEN, storage: "environment", created: false };
  mkdirSync(dataDirectory, { recursive: true });
  const tokenFile = join(dataDirectory, TOKEN_FILE);
  const fileToken = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() || null : null;

  if (vaultUsable({ vault, env, os })) {
    try {
      const stored = await vault.get(OWNER_TOKEN_NAME);
      if (stored) {
        if (fileToken) rmSync(tokenFile, { force: true });
        return { token: stored, storage: vault.backend, created: false };
      }
      const token = fileToken ?? randomBytes(32).toString("base64url");
      await vault.set(OWNER_TOKEN_NAME, token);
      // Only trust the vault once it gives the token back.
      if ((await vault.get(OWNER_TOKEN_NAME)) === token) {
        if (fileToken) { rmSync(tokenFile, { force: true }); log(`Moved the owner token into the ${vault.backend} vault.`); }
        return { token, storage: vault.backend, created: !fileToken };
      }
    } catch {
      // Fall through to the file: a locked or missing keyring must not stop Atlas.
    }
  }
  if (fileToken) return { token: fileToken, storage: "file", created: false };
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
  return { token, storage: "file", created: true };
}

/** The app URL that signs this browser tab in as the owner. */
export function signInUrl(baseUrl, token) {
  return `${String(baseUrl).replace(/\/+$/u, "")}/#signin=${encodeURIComponent(token)}`;
}

/** Opens a URL in the default browser without a shell. */
export function openInBrowser(url, { os = platform(), spawnImpl = spawn } = {}) {
  const [command, args] = os === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : os === "darwin" ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    const child = spawnImpl(command, args, { shell: false, stdio: "ignore", detached: true, windowsHide: true });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
