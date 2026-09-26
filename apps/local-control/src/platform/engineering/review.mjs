import { createRedactor, hostSecretValues } from "../terminal/redaction.mjs";
import { matchesGlob } from "./ownership.mjs";

/**
 * Diff review and security scanning over added lines (blueprint §7).
 *
 * Pattern-based, and honest about it: this catches the common mistakes an
 * agent makes (committing a token, touching CI workflows, adding eval or a
 * subprocess call) and routes them to a human. It is not a substitute for a
 * real SAST tool. Findings never carry the secret itself — only the redacted
 * line, whose placeholder names the category.
 */

/** Paths an agent change may never touch without a human doing it. */
export const DEFAULT_FORBIDDEN_PATHS = Object.freeze([
  ".github/workflows/**",
  ".github/actions/**",
  ".git/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/.npmrc",
]);

/** Risky constructs flagged for review (not blocked). */
export const SECURITY_PATTERNS = Object.freeze([
  { id: "eval", pattern: /\beval\s*\(/, message: "eval() executes arbitrary strings as code" },
  { id: "new-function", pattern: /\bnew\s+Function\s*\(/, message: "new Function() executes arbitrary strings as code" },
  { id: "child-process", pattern: /(["'`])(?:node:)?child_process\1/, message: "imports child_process (subprocess execution)" },
  { id: "exec-call", pattern: /\b(?:execSync|execFileSync|spawnSync|exec|execFile|spawn)\s*\(/, message: "starts a subprocess" },
  { id: "vm-run", pattern: /\bvm\.(?:runIn\w*|compileFunction)\s*\(/, message: "runs code through node:vm" },
  { id: "shell-true", pattern: /\bshell\s*:\s*true\b/, message: "spawns through a shell" },
  { id: "tls-disabled", pattern: /NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized\s*:\s*false/, message: "disables TLS verification" },
]);

let sharedRedactor = null;
function redactor() {
  sharedRedactor ??= createRedactor({ knownSecrets: hostSecretValues() });
  return sharedRedactor;
}

/** Redacts a string with the terminal controller's rule set. */
export function redactText(text) {
  return redactor()(String(text ?? "")).text;
}

/** Changed paths matching any forbidden glob. */
export function forbiddenPathChanges(files, forbidden = DEFAULT_FORBIDDEN_PATHS) {
  const hits = [];
  for (const file of files) {
    const globs = forbidden.filter((glob) => matchesGlob(glob, file));
    if (globs.length) hits.push({ path: file, globs });
  }
  return hits;
}

/** Secret findings in added lines: `{ path, line, categories, redacted }`. */
export function scanSecrets(lines) {
  const findings = [];
  for (const { path, line, text } of lines) {
    const { text: redacted, count } = redactor()(text);
    if (count > 0) {
      const categories = [...new Set([...redacted.matchAll(/\[redacted:([a-z0-9-]+)\]/g)].map((match) => match[1]))];
      findings.push({ path, line, categories, redacted: redacted.slice(0, 300) });
    }
  }
  return findings;
}

/** Risky-construct findings in added lines (lines are redacted before being quoted). */
export function scanSecurityPatterns(lines, patterns = SECURITY_PATTERNS) {
  const findings = [];
  for (const { path, line, text } of lines) {
    for (const rule of patterns) {
      if (rule.pattern.test(text)) findings.push({ rule: rule.id, message: rule.message, path, line, excerpt: redactText(text).trim().slice(0, 200) });
    }
  }
  return findings;
}
