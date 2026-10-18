import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * When a Genesis project reaches "ready", record it as an artifact so it
 * shows up next to everything else Atlas made.
 *
 * The bytes are a site manifest (application/vnd.atlas.site-manifest+json):
 * the project's name, template and every source file's path, size and
 * sha256. It contains no timestamps, so an unchanged project records the same
 * artifact again (idempotent) and a changed one records a new artifact. The
 * project itself is seen through its live Genesis preview, which the record's
 * previewUrl points to.
 */

const SKIP = new Set(["node_modules", ".git", ".atlas", ".cache", ".next", "coverage"]);
const MAX_FILES = 2000;
const MAX_HASHED_FILE = 16 * 1024 * 1024;

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function listFiles(root) {
  const files = [];
  let truncated = false;
  const walk = async (folder) => {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) { truncated = true; return; }
      if (SKIP.has(entry.name)) continue;
      const full = join(folder, entry.name);
      // Symbolic links are not followed: the manifest describes the project folder only.
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const { size } = await stat(full);
        files.push({ path: relative(root, full).split(sep).join("/"), size, sha256: size <= MAX_HASHED_FILE ? await sha256File(full) : null });
      }
    }
  };
  await walk(root);
  return { files, truncated };
}

/** The manifest bytes for a project. */
export async function siteManifest(project) {
  const { files, truncated } = project.workspace ? await listFiles(project.workspace) : { files: [], truncated: false };
  return JSON.stringify({
    format: "atlas.site-manifest.v1",
    projectId: project.id,
    name: project.spec?.name ?? project.name,
    template: project.plan?.template ?? null,
    files,
    truncated,
  }, null, 1);
}

/**
 * Records a ready project. Returns the store's `{ artifact, created }`.
 * @param {{ artifacts: import("./store.mjs").ArtifactStore, project: object, tenantId?: string }} options
 */
export async function recordGenesisArtifact({ artifacts, project, tenantId = project.tenantId ?? "local" }) {
  const kind = project.plan?.template === "static-site" ? "website" : "app";
  const slug = String(project.name ?? "project").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 80) || "project";
  return artifacts.put({
    tenantId,
    kind,
    mediaType: "application/vnd.atlas.site-manifest+json",
    bytes: await siteManifest(project),
    name: `${slug}.site.json`,
    provenance: { runId: project.id, step: "ready", source: "genesis" },
    // The Genesis view in the local console: it shows the live preview and can restart it.
    previewUrl: `/#/build/${project.id}`,
  });
}
