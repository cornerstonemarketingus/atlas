import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const fail = message => Object.assign(new Error(message), { code: "INVALID_EVIDENCE" });

/** Check executor artifacts independently of model prose. Never apply a patch here. */
export function createMissionEvidenceVerifier({ patchDirectory, maxBytes = 20 * 1024 * 1024 }) {
  if (typeof patchDirectory !== "string" || !isAbsolute(patchDirectory)) throw new TypeError("An absolute patch directory is required.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be a positive integer.");
  return async ({ child, result }) => {
    const required = child.metadata?.requiredEvidence ?? [];
    if (!Array.isArray(required)) throw fail("Evidence requirements must be an array.");
    if (!required.length || ["failed", "cancelled"].includes(result?.status)) return result;
    if (required.includes("validation")) throw fail("Independent validation is unavailable; executor claims cannot satisfy required validation.");
    if (required.some(kind => kind !== "patch")) throw fail("This executor only verifies patch artifacts.");
    if (!Array.isArray(result?.evidence) || !result.evidence.some(item => item?.kind === "patch")) throw fail("The child returned no patch artifact.");
    const root = await realpath(patchDirectory);
    const evidence = [];
    for (const item of result.evidence) {
      // Preserve executor reports for inspection, but do not let them impersonate
      // independently evaluated test or operational receipts.
      if (item?.kind !== "patch") { evidence.push(item && typeof item === "object" ? { ...item, verification: "executor-reported" } : item); continue; }
      if (typeof item.path !== "string" || !isAbsolute(item.path)) throw fail("Patch artifacts require an absolute path.");
      const target = await realpath(resolve(item.path));
      const inside = relative(root, target);
      if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw fail("Patch artifact is outside the configured directory.");
      const handle = await open(target, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw fail("Patch artifact must be a nonempty bounded file.");
        // Read with an explicit bound even if the file grows after stat().
        const content = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < content.length) {
          const read = await handle.read(content, length, content.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== stat.size || !content.subarray(0, length).toString("utf8").startsWith("diff --git ")) throw fail("Artifact is not a stable Git patch.");
        const sha256 = createHash("sha256").update(content.subarray(0, length)).digest("hex");
        if (item.bytes !== undefined && item.bytes !== null && item.bytes !== length) throw fail("Patch size does not match its evidence.");
        if (item.sha256 !== undefined && item.sha256 !== sha256) throw fail("Patch digest does not match its evidence.");
        evidence.push({ ...item, path: target, bytes: length, sha256, verification: "artifact-verified", verifiedAt: new Date().toISOString() });
      } finally { await handle.close(); }
    }
    return {
      ...result,
      evidence,
      // This authoritative receipt replaces executor prose/claims. Hashes bind
      // the scope to exactly the bytes read here, not future worktree contents.
      verification: {
        schemaVersion: 1,
        evaluator: "mission-artifact-verifier",
        artifacts: evidence.filter(item => item?.kind === "patch").map(({ sha256, bytes }) => ({ kind: "patch", sha256, bytes })),
        validation: { status: "unavailable", reason: "No independently evaluated test receipt is available at this boundary." },
        liveOutcomes: { status: "not-evaluated", reason: "Preparation patches do not establish deployed health or business outcomes." },
      },
    };
  };
}
