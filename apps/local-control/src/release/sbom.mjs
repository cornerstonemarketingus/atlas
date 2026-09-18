import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * A software bill of materials, in CycloneDX form.
 *
 * Atlas's own packages take no third-party runtime dependencies, which is a
 * claim worth being able to *prove* rather than assert — so the SBOM is
 * generated from the lockfiles and manifests actually present, and a package
 * with no dependencies produces an SBOM that says so.
 */
export const SBOM_FORMAT = "CycloneDX";
export const SBOM_SPEC_VERSION = "1.5";

export async function collectComponents(root, { readFileImpl = readFile } = {}) {
  const manifests = await findManifests(root);
  const components = new Map();

  for (const manifestPath of manifests) {
    const manifest = safeJson(await readFileImpl(manifestPath, "utf8"));
    if (!manifest) continue;
    const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    for (const [name, range] of Object.entries(dependencies)) {
      const key = `${name}@${range}`;
      if (!components.has(key)) {
        components.set(key, {
          type: "library",
          name,
          version: String(range).replace(/^[\^~]/u, ""),
          scope: manifest.dependencies?.[name] ? "required" : "optional",
          purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(String(range).replace(/^[\^~]/u, ""))}`,
          // Which of our packages pulls it in — the question anyone reading an
          // SBOM actually has.
          usedBy: [relative(root, manifestPath)],
        });
      } else {
        components.get(key).usedBy.push(relative(root, manifestPath));
      }
    }
  }

  return [...components.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function generateSbom({ root, product, version, readFileImpl = readFile }) {
  const components = await collectComponents(root, { readFileImpl });
  return {
    bomFormat: SBOM_FORMAT,
    specVersion: SBOM_SPEC_VERSION,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: "application", name: product, version },
    },
    components,
  };
}

/** SHA-256 for every file in a release directory, in the usual sha256sum form. */
export async function checksumDirectory(directory) {
  const lines = [];
  for await (const path of walk(directory)) {
    const bytes = await readFile(path);
    lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${relative(directory, path).replaceAll("\\", "/")}`);
  }
  return lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n") + (lines.length > 0 ? "\n" : "");
}

export function parseChecksums(text) {
  return new Map(
    String(text)
      .split("\n")
      .map((line) => /^([0-9a-f]{64})\s+(.+)$/u.exec(line.trim()))
      .filter(Boolean)
      .map((match) => [match[2], match[1]]),
  );
}

async function findManifests(root) {
  const found = [];
  for (const relativePath of ["package.json", "apps", "packages"]) {
    const target = join(root, relativePath);
    const info = await stat(target).catch(() => null);
    if (!info) continue;
    if (info.isFile()) { found.push(target); continue; }
    for (const entry of await readdir(target, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const manifest = join(target, entry.name, "package.json");
      if (await stat(manifest).then(() => true).catch(() => false)) found.push(manifest);
    }
  }
  return found;
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
