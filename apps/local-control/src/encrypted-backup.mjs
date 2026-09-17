import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const VERSION = 1;

export function encryptBackup(value, passphrase) {
  requirePassphrase(passphrase);
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { version: VERSION, algorithm: "aes-256-gcm+scrypt", salt: salt.toString("base64url"), iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

export function decryptBackup(envelope, passphrase) {
  requirePassphrase(passphrase);
  if (!envelope || envelope.version !== VERSION || envelope.algorithm !== "aes-256-gcm+scrypt") throw new Error("Unsupported Atlas backup format.");
  try {
    const salt = Buffer.from(envelope.salt, "base64url"), iv = Buffer.from(envelope.iv, "base64url"), tag = Buffer.from(envelope.tag, "base64url");
    const key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8"));
  } catch { throw new Error("Backup authentication failed. Check the passphrase and file integrity."); }
}

function requirePassphrase(value) { if (typeof value !== "string" || value.length < 12) throw new Error("Backup passphrase must contain at least 12 characters."); }
