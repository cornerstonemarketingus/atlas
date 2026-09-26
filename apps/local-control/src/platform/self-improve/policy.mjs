import { DEFAULT_FORBIDDEN_PATHS, forbiddenPathChanges, scanSecrets, scanSecurityPatterns } from "../engineering/review.mjs";

/**
 * The self-modification policy: what one self-improvement attempt may change.
 *
 * Atlas changing Atlas is the case where a bad change is most expensive (it
 * can weaken the very checks that would catch the next bad change), so the
 * limits are deliberately tight and deterministic. A change is accepted only
 * when every rule here passes AND the independent reviewer approves; either
 * one alone is never enough.
 *
 * - Small: at most MAX_FILES files and MAX_CHANGED_LINES added+deleted lines.
 * - Never the safety surface: CI and release workflows, runner scripts,
 *   policies, approvals, authentication, sandboxing, redaction, secrets and
 *   this policy itself are off limits (DEFAULT_FORBIDDEN_PATHS plus
 *   SELF_FORBIDDEN_PATHS). A person changes those.
 * - Tests only grow: no test file deleted, and the test count after the
 *   change must be at least the count before it.
 * - Nothing secret-shaped and no risky construct (eval, subprocess, disabled
 *   TLS, …) in added lines.
 */

export const MAX_FILES = 8;
export const MAX_CHANGED_LINES = 400;

export const SELF_FORBIDDEN_PATHS = Object.freeze([
  "scripts/runner/**",
  "scripts/release/**",
  "**/policy.mjs",
  "**/command-policy.mjs",
  "**/permissions.mjs",
  "**/approval*.mjs",
  "**/approvals/**",
  "**/redaction.mjs",
  "**/container-sandbox.mjs",
  "**/namespace-sandbox.mjs",
  "**/path-confinement.mjs",
  "**/credential-vault.mjs",
  "**/self-improve/**",
  "apps/web/app/api/auth/**",
  "apps/web/app/api/tasks/operator-auth.mjs",
  "apps/web/app/api/tasks/self-protection.mjs",
  "apps/web/app/api/tasks/dispatch.mjs",
  "apps/web/db/tenancy.mjs",
  "apps/web/drizzle/**",
  "packages/atlas-contracts/**",
  "**/package-lock.json",
  "**/package.json",
]);

export const FORBIDDEN_PATHS = Object.freeze([...DEFAULT_FORBIDDEN_PATHS, ...SELF_FORBIDDEN_PATHS]);

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/u;

export function isTestFile(path) {
  return TEST_FILE.test(String(path ?? ""));
}

/**
 * @param {{
 *   stats: { files: { path: string, added: number|null, deleted: number|null }[], totals: { files: number, added: number, deleted: number } },
 *   added: { path: string, line: number, text: string }[],
 *   deletedFiles?: string[],
 *   testsBefore?: number|null,
 *   testsAfter?: number|null,
 *   limits?: { maxFiles?: number, maxChangedLines?: number, forbidden?: readonly string[] },
 * }} change
 * @returns {{ allowed: boolean, violations: { rule: string, detail: string }[] }}
 */
export function evaluateChange({ stats, added = [], deletedFiles = [], testsBefore = null, testsAfter = null, limits = {} }) {
  const maxFiles = limits.maxFiles ?? MAX_FILES;
  const maxLines = limits.maxChangedLines ?? MAX_CHANGED_LINES;
  const violations = [];
  const files = stats?.files ?? [];
  if (!files.length) violations.push({ rule: "empty", detail: "The attempt changed nothing." });
  if (files.length > maxFiles) violations.push({ rule: "too-many-files", detail: `${files.length} files changed; the limit is ${maxFiles}.` });
  const changed = (stats?.totals?.added ?? 0) + (stats?.totals?.deleted ?? 0);
  if (changed > maxLines) violations.push({ rule: "too-large", detail: `${changed} lines changed; the limit is ${maxLines}.` });
  if (files.some((file) => file.binary)) violations.push({ rule: "binary", detail: "Binary files may not be changed by a self-improvement." });
  for (const hit of forbiddenPathChanges(files.map((file) => file.path), limits.forbidden ?? FORBIDDEN_PATHS)) {
    violations.push({ rule: "forbidden-path", detail: `${hit.path} is off limits (${hit.globs.join(", ")}).` });
  }
  for (const path of deletedFiles.filter(isTestFile)) violations.push({ rule: "deleted-test", detail: `${path} is a test file and was deleted.` });
  if (Number.isInteger(testsBefore) && Number.isInteger(testsAfter) && testsAfter < testsBefore) {
    violations.push({ rule: "fewer-tests", detail: `The test count dropped from ${testsBefore} to ${testsAfter}.` });
  }
  for (const finding of scanSecrets(added)) violations.push({ rule: "secret", detail: `${finding.path}:${finding.line} looks like a credential (${finding.categories.join(", ")}).` });
  for (const finding of scanSecurityPatterns(added)) violations.push({ rule: `risky-${finding.rule}`, detail: `${finding.path}:${finding.line} ${finding.message}.` });
  return { allowed: violations.length === 0, violations };
}
