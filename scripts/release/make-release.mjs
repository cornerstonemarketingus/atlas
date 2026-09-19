#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checksumDirectory, generateSbom } from "../../apps/local-control/src/release/sbom.mjs";
import { createUpdateManifest } from "../../apps/local-control/src/release/update-manifest.mjs";

/**
 * Produces the three things a release needs to be verifiable: a SHA-256
 * checksum file, a CycloneDX SBOM, and a signed update manifest.
 *
 * It runs on any platform on purpose. The MSI itself has to be built on
 * Windows, but nothing about proving what is in a release should require it —
 * that would make the verification step the one nobody can reproduce.
 */
const atlasRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

if (process.argv.includes("--help")) {
  console.log(`Usage:
  node scripts/release/make-release.mjs --version <semver> --artifacts <dir> [options]

Options:
  --out <dir>              Where to write the release metadata (default: the artifacts directory)
  --product <name>         Product name (default: Atlas)
  --rollback-to <semver>   Version a failed upgrade must return to
  --minimum-from <semver>  Oldest version that may upgrade directly to this one
  --signing-key <path>     PKCS#8 Ed25519 private key. Without it, no manifest is written.

The signing key is read from disk and never printed. A release without one is
a development build: it gets checksums and an SBOM, but no update manifest,
because an unsigned manifest is worse than none.`);
  process.exit(0);
}

const version = option("--version");
const artifacts = option("--artifacts");
if (!version || !artifacts) throw new Error("--version and --artifacts are required. Run with --help for usage.");

const product = option("--product", "Atlas");
const outputDirectory = resolve(option("--out", artifacts));
const artifactDirectory = resolve(artifacts);
await mkdir(outputDirectory, { recursive: true });

const checksums = await checksumDirectory(artifactDirectory);
if (!checksums.trim()) throw new Error(`No files were found in ${artifactDirectory}.`);
await writeFile(join(outputDirectory, "SHA256SUMS.txt"), checksums, "utf8");

const sbom = await generateSbom({ root: atlasRoot, product, version });
await writeFile(join(outputDirectory, `${product}-${version}.cdx.json`), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

const signingKeyPath = option("--signing-key");
if (!signingKeyPath) {
  console.log(`Wrote SHA256SUMS.txt and an SBOM for ${product} ${version}.`);
  console.log("No signing key was supplied, so no update manifest was written. This is a development build.");
  process.exit(0);
}

const entries = checksums.trim().split("\n").map((line) => {
  const [sha256, name] = [line.slice(0, 64), line.slice(66)];
  return { sha256, name };
});
const sized = await Promise.all(entries.map(async (entry) => ({
  ...entry,
  bytes: (await readFile(join(artifactDirectory, entry.name))).length,
})));

const manifest = createUpdateManifest({
  product,
  version,
  releasedAt: new Date().toISOString(),
  rollbackTo: option("--rollback-to"),
  minimumUpgradeFrom: option("--minimum-from"),
  artifacts: sized,
  privateKeyPem: await readFile(resolve(signingKeyPath), "utf8"),
});
await writeFile(join(outputDirectory, "update-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Wrote SHA256SUMS.txt, an SBOM, and a signed update manifest for ${product} ${version}.`);
console.log(`Artifacts covered: ${sized.length}.`);
