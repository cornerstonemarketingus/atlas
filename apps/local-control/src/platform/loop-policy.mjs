import { createHash } from "node:crypto";

/**
 * Limits for an autonomous improve loop (create → execute → inspect → test →
 * improve): how many repair iterations, how long, how many model tokens, and
 * how many times the same failure may survive a repair before the loop stops
 * instead of paying to fix it again. Checked before each iteration starts, so
 * a limit is never crossed by starting one more attempt.
 */
export const DEFAULT_LOOP_POLICY = Object.freeze({
  maxIterations: 3,
  maxWallMs: 6 * 60 * 60_000,
  maxTokens: null,
  maxSameFailure: 2,
});

export const STOP_REASONS = Object.freeze(["iteration-limit", "time-limit", "spend-limit", "no-progress"]);

/**
 * A stable identity for "the same failure": the stage, check and exit code,
 * plus the failure output with run-specific noise (timings, line/column
 * numbers, hashes, absolute paths, ports) removed.
 */
export function failureFingerprint(failure = {}) {
  const output = String(failure.output ?? (failure.findings ? JSON.stringify(failure.findings) : failure.reason ?? ""))
    .slice(-1500)
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@-]+)+[\\/]([\w.@-]+)/gu, "$1")
    .replace(/\b[0-9a-f]{7,64}\b/giu, "#")
    .replace(/\d+(?:\.\d+)?/gu, "#")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  const key = [failure.stage ?? "", failure.check ?? "", failure.exitCode ?? "", output].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Whether another repair iteration may start.
 * `iterations` are the repairs already made in this loop, oldest first:
 * `{ fingerprint, tokens }` where `fingerprint` is the failure the repair
 * targeted and `tokens` is what it cost (null when unmetered).
 */
export function decideIteration({ policy = DEFAULT_LOOP_POLICY, iterations = [], startedAt, now, fingerprint }) {
  const limits = { ...DEFAULT_LOOP_POLICY, ...policy };
  const elapsedMs = Math.max(0, now - startedAt);
  const metered = iterations.filter((it) => Number.isFinite(it.tokens));
  const tokens = metered.reduce((sum, it) => sum + it.tokens, 0);
  const sameFailure = iterations.filter((it) => it.fingerprint === fingerprint).length;
  const facts = { iterations: iterations.length, elapsedMs, tokens, unmeteredIterations: iterations.length - metered.length, sameFailure, fingerprint };
  const stop = (reason, message) => ({ proceed: false, reason, message, ...facts });
  if (iterations.length >= limits.maxIterations) return stop("iteration-limit", `Still failing after ${iterations.length} repair attempt(s)`);
  if (Number.isFinite(limits.maxWallMs) && elapsedMs >= limits.maxWallMs) return stop("time-limit", `Stopped after ${Math.round(elapsedMs / 60_000)} minute(s), the time limit for repairs`);
  if (Number.isFinite(limits.maxTokens) && tokens >= limits.maxTokens) return stop("spend-limit", `Stopped after ${tokens} model tokens, the spending limit for repairs`);
  if (sameFailure >= limits.maxSameFailure) return stop("no-progress", `Stopped: the same failure survived ${sameFailure} repair attempt(s), so another attempt is unlikely to help`);
  return { proceed: true, ...facts };
}

/**
 * Owner overrides from the environment: ATLAS_REPAIR_MAX_MINUTES and
 * ATLAS_REPAIR_MAX_TOKENS. A missing or invalid value keeps the default; an
 * invalid value is reported rather than silently treated as "no limit".
 */
export function loopPolicyFromEnvironment(env = process.env, warn = () => {}) {
  const policy = {};
  const read = (name, apply) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) apply(value);
    else warn(`${name}=${raw} is not a positive whole number; keeping the default.`);
  };
  read("ATLAS_REPAIR_MAX_MINUTES", (value) => { policy.maxWallMs = value * 60_000; });
  read("ATLAS_REPAIR_MAX_TOKENS", (value) => { policy.maxTokens = value; });
  return policy;
}
