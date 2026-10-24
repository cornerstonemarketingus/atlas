import { isAbsolute } from "node:path";
import type { ReadOnlyToolRegistry } from "../domain/read-only-tool-registry.js";

/** Only source paths explicitly named by the user, through the normal read policy. */
export async function objectiveSourceContext(objective: string, registry: ReadOnlyToolRegistry, repositoryId: string) {
  const paths = [...new Set([...objective.matchAll(/[A-Za-z0-9_./\\:-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|cpp|cs|rb|swift)\b/gu)]
    .map(match => match[0].replace(/^\.\//u, "")))]
    .filter(path => !isAbsolute(path) && !path.includes(":") && !path.includes("\\") && !path.split("/").some(part => !part || part === ".."))
    .slice(0, 6);
  const evidence: { label: string; content: string }[] = [];
  let remaining = 6000;
  for (const path of paths) {
    if (remaining < 1000) break;
    try {
      const read = await registry.execute({ name: "repository.read_source", input: { path, maxBytes: Math.min(3000, Math.floor(remaining / 2)), maxLines: 100 },
        scope: { kind: "repository", repositoryId }, context: { repositoryId } });
      if (read.status !== "completed") continue;
      const content = JSON.stringify(read.output);
      if (content.length > remaining) continue;
      evidence.push({ label: `Untrusted bounded source excerpt: ${path}`, content });
      remaining -= content.length;
    } catch { /* Missing or refused files add no context; the normal tools remain available. */ }
  }
  return evidence;
}
