/**
 * Device credentials, in the Keychain or the Android Keystore.
 *
 * The rule this file exists to enforce: a paired-device credential must never
 * touch web storage. `localStorage` in a WebView is readable by any script
 * that gets injected into the page and survives on disk unencrypted; a
 * credential there is a credential in a backup, in a crash dump, and in
 * whatever the next XSS reaches. So the only storage path is the platform
 * vault, and there is deliberately no fallback to `localStorage` when it is
 * unavailable -- a fallback is how the rule gets quietly broken.
 */
export const CREDENTIAL_KEYS = ["atlas.device.credential", "atlas.push.token", "atlas.deeplink.secret"];

export class SecureStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SecureStorageError";
    this.code = code;
  }
}

export function createSecureStorage({ plugin, platform = "ios" }) {
  if (!plugin) {
    throw new SecureStorageError(
      "NO_SECURE_STORAGE",
      `This device has no ${platform === "ios" ? "Keychain" : "Keystore"} available to Atlas. Pairing is unavailable here; Atlas will not fall back to browser storage for a device credential.`,
    );
  }

  function assertKey(key) {
    if (!CREDENTIAL_KEYS.includes(key)) throw new SecureStorageError("UNKNOWN_KEY", `'${key}' is not an Atlas credential key.`);
    return key;
  }

  return {
    async set(key, value) {
      assertKey(key);
      if (typeof value !== "string" || value.length === 0) throw new SecureStorageError("EMPTY", "A credential cannot be empty.");
      await plugin.set({ key, value });
      return { key, stored: true };
    },
    async get(key) {
      assertKey(key);
      try {
        const result = await plugin.get({ key });
        return result?.value ?? null;
      } catch {
        // A missing key is a normal state, not a failure worth surfacing.
        return null;
      }
    },
    async remove(key) {
      assertKey(key);
      await plugin.remove({ key });
      return { key, removed: true };
    },
    /**
     * Called when the daemon says this device was revoked, and on sign-out.
     * Everything goes: a half-cleared device still receives notifications.
     */
    async clearAll() {
      const cleared = [];
      for (const key of CREDENTIAL_KEYS) {
        await plugin.remove({ key }).catch(() => {});
        cleared.push(key);
      }
      return { cleared };
    },
  };
}

/**
 * A guard against the mistake this file exists to prevent. Called at startup
 * so the failure is loud and immediate rather than a credential sitting in
 * web storage for a release or two.
 */
export function assertNoCredentialsInWebStorage(storages) {
  const offenders = [];
  for (const [name, storage] of Object.entries(storages ?? {})) {
    if (!storage) continue;
    for (let index = 0; index < (storage.length ?? 0); index += 1) {
      const key = storage.key(index);
      if (CREDENTIAL_KEYS.includes(key) || /credential|device[-_.]?token|push[-_.]?token/iu.test(key ?? "")) {
        offenders.push(`${name}.${key}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new SecureStorageError("CREDENTIAL_IN_WEB_STORAGE", `Credentials must never be kept in web storage. Found: ${offenders.join(", ")}.`);
  }
  return true;
}
