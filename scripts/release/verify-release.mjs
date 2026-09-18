#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { join, resolve } from "node:path";

import { decideUpdate, verifyArtifact, verifyUpdateManifest } from "../../apps/local-control/src/release/update-manifest.mjs";
import { parseChecksums } from "../../apps/local-control/src/release/sbom.mjs";

/**
 * Verifies a release the way the updater will.
 *
 * Running this in CI means the signing and verification paths are exercised
 * on every change, rather than first meeting each other during a release.
 */
function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

const manifestPath = option("--manifest");
const keyPath = option("--key");
const artifactsDirectory = option("--artifacts");
if (!manifestPath || !keyPath || !artifactsDirectory) {
  throw new Error("--manifest, --key and --artifacts are required.");
}

const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
const keyPem = await readFile(resolve(keyPath), "utf8");
// Accepts either half of the pair, so CI can verify with the key it signed with.
const publicKeyPem = keyPem.includes("PRIVATE KEY")
  ? createPublicKey(createPrivateKey(keyPem)).export({ type: "spki", format: "pem" })
  : keyPem;

const verified = verifyUpdateManifest(manifest, publicKeyPem);
if (!verified.valid) throw new Error(`The manifest did not verify: ${verified.reason}`);
console.log(`Manifest for ${manifest.product} ${manifest.version} verified.`);

for (const artifact of manifest.artifacts) {
  const bytes = await readFile(join(resolve(artifactsDirectory), artifact.name));
  const result = verifyArtifact({ manifest, name: artifact.name, bytes });
  if (!result.valid) throw new Error(`${artifact.name} did not verify: ${result.reason}`);
  console.log(`  ${artifact.name} matches its digest (${artifact.bytes} bytes).`);
}

// The two decisions that must always hold, checked rather than assumed.
const upgrade = decideUpdate({ manifest, installedVersion: "0.0.0-dev", publicKeyPem });
if (upgrade.decision !== "install") throw new Error(`Expected an upgrade from a prerelease to install, got: ${upgrade.reason}`);
const downgrade = decideUpdate({ manifest, installedVersion: "99.0.0", publicKeyPem });
if (downgrade.decision !== "reject") throw new Error("A downgrade was not refused.");
console.log("Upgrade and downgrade decisions behave correctly.");

const tampered = { ...manifest, version: "99.9.9" };
if (verifyUpdateManifest(tampered, publicKeyPem).valid) throw new Error("A tampered manifest verified. The signature does not cover the version.");
console.log("A tampered manifest is rejected.");

const sums = await readFile(join(resolve(artifactsDirectory), "..", "ci-out", "SHA256SUMS.txt"), "utf8").catch(() => null);
if (sums) {
  const parsed = parseChecksums(sums);
  for (const artifact of manifest.artifacts) {
    if (parsed.get(artifact.name) !== artifact.sha256) throw new Error(`${artifact.name} disagrees between the checksum file and the manifest.`);
  }
  console.log("Checksum file and manifest agree.");
}
