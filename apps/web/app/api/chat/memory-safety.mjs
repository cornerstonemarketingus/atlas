/**
 * Secret-shaped strings must never be stored in durable chat memory.
 *
 * These patterns mirror the repository's established secret redaction rules
 * closely enough to catch the same common credential shapes without importing
 * the CLI package into the Worker bundle.
 */

const LEFT_EDGE = String.raw`(?<![A-Za-z0-9_\-])`;
const RIGHT_EDGE = String.raw`(?![A-Za-z0-9_\-])`;

const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu,
  new RegExp(`${LEFT_EDGE}gh[pousr]_[A-Za-z0-9]{20,255}${RIGHT_EDGE}`, "iu"),
  new RegExp(`${LEFT_EDGE}github_pat_[A-Za-z0-9_]{20,255}${RIGHT_EDGE}`, "iu"),
  new RegExp(`${LEFT_EDGE}gsk_[A-Za-z0-9]{20,}${RIGHT_EDGE}`, "iu"),
  new RegExp(`${LEFT_EDGE}sk-ant-[A-Za-z0-9_-]{16,}${RIGHT_EDGE}`, "iu"),
  new RegExp(`${LEFT_EDGE}sk-(?:proj-)?[A-Za-z0-9_-]{16,}${RIGHT_EDGE}`, "iu"),
  new RegExp(`${LEFT_EDGE}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}${RIGHT_EDGE}`, "iu"),
  new RegExp(`${LEFT_EDGE}whsec_[A-Za-z0-9]{16,}${RIGHT_EDGE}`, "iu"),
  new RegExp(`${LEFT_EDGE}xox[abprs]-[A-Za-z0-9-]{10,}${RIGHT_EDGE}`, "iu"),
  new RegExp(`${LEFT_EDGE}AIza[0-9A-Za-z_-]{35,}${RIGHT_EDGE}`, "iu"),
  /^[ \t]*(?:-[ \t]+)?(?:export[ \t]+)?["']?[A-Za-z0-9_.-]*?(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?)["']?[ \t]*[:=][ \t]*["']?[A-Za-z0-9_\-./+=:~!@#$%^&*]{6,512}(?![A-Za-z0-9_\-./+=:~!@#$%^&*(])/imu,
];

export function memoryContentLooksSecret(content) {
  const text = String(content ?? "");
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
