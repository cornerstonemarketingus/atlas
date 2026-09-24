import { digest } from "../../../packages/atlas-contracts/src/index.mjs";

/**
 * Deterministic extraction verifier. It never calls a model: each expected
 * field is compared by exact string equality or by a regular expression
 * anchored to the whole value, and every comparison yields an evidence record
 * the control plane can store with the artifact.
 *
 * @param {{artifactContent: object, expected: Record<string, string | {pattern: string}>}} args
 *   `artifactContent` may be an extraction output ({values: {...}}) or a plain map of values.
 * @returns {{ok: boolean, evidence: object[]}}
 */
export function verifyExtraction({ artifactContent, expected } = {}) {
  const evidence = [];
  if (!expected || typeof expected !== "object" || !Object.keys(expected).length) {
    return { ok: false, evidence: [{ check: "expected", ok: false, reason: "No expected fields were given." }] };
  }
  const values = artifactContent && typeof artifactContent === "object"
    ? (artifactContent.values && typeof artifactContent.values === "object" ? artifactContent.values : artifactContent)
    : {};
  for (const [field, rule] of Object.entries(expected)) {
    const actual = values[field];
    if (typeof actual !== "string") {
      evidence.push({ check: "field", field, ok: false, reason: actual == null ? "missing" : "not a string" });
      continue;
    }
    if (typeof rule === "string") {
      const ok = actual === rule;
      evidence.push({ check: "field", field, mode: "exact", ok, expected: rule, actualDigest: digest(actual), ...(ok ? {} : { actual: actual.slice(0, 200) }) });
    } else if (rule && typeof rule.pattern === "string") {
      let regex;
      try {
        regex = new RegExp(`^(?:${rule.pattern})$`, "u");
      } catch {
        evidence.push({ check: "field", field, mode: "pattern", ok: false, reason: "invalid pattern" });
        continue;
      }
      const ok = regex.test(actual);
      evidence.push({ check: "field", field, mode: "pattern", ok, pattern: rule.pattern, actualDigest: digest(actual), ...(ok ? {} : { actual: actual.slice(0, 200) }) });
    } else {
      evidence.push({ check: "field", field, ok: false, reason: "unsupported rule" });
    }
  }
  return { ok: evidence.every((entry) => entry.ok), evidence };
}
