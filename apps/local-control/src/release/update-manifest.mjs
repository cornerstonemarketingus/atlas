import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/**
 * Signed update manifests, with rollback.
 *
 * An updater that trusts a manifest it downloaded is an updater that installs
 * whatever a compromised mirror serves. So a manifest carries an Ed25519
 * signature over its own canonical form, and the installer checks it against
 * a key shipped with the product rather than one named in the manifest.
 *
 * `rollbackTo` is part of the signed payload: a release states which version
 * a failed upgrade must return to, so recovery does not depend on the failing
 * version being able to work out its own predecessor.
 */
export const MANIFEST_VERSION = 1;

export class ManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** Field order is fixed so the bytes signed are the bytes verified. */
export function canonicalManifest(manifest) {
  return JSON.stringify({
    manifestVersion: MANIFEST_VERSION,
    product: manifest.product,
    version: manifest.version,
    releasedAt: manifest.releasedAt,
    minimumUpgradeFrom: manifest.minimumUpgradeFrom ?? null,
    rollbackTo: manifest.rollbackTo ?? null,
    artifacts: [...manifest.artifacts]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((artifact) => ({ name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256 })),
  });
}

export function createUpdateManifest({ product, version, releasedAt, artifacts, rollbackTo = null, minimumUpgradeFrom = null, privateKeyPem }) {
  if (!SEMVER.test(version ?? "")) throw new ManifestError("BAD_VERSION", `'${version}' is not a semantic version.`);
  if (rollbackTo !== null && !SEMVER.test(rollbackTo)) throw new ManifestError("BAD_VERSION", `rollbackTo '${rollbackTo}' is not a semantic version.`);
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new ManifestError("NO_ARTIFACTS", "A manifest must list at least one artifact.");
  for (const artifact of artifacts) {
    if (!/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? "")) throw new ManifestError("BAD_DIGEST", `Artifact '${artifact.name}' needs a SHA-256 digest.`);
  }

  const body = { product, version, releasedAt, artifacts, rollbackTo, minimumUpgradeFrom, manifestVersion: MANIFEST_VERSION };
  const signature = sign(null, Buffer.from(canonicalManifest(body), "utf8"), createPrivateKey(privateKeyPem));
  return { ...body, signature: signature.toString("base64") };
}

export function verifyUpdateManifest(manifest, publicKeyPem) {
  if (!manifest || manifest.manifestVersion !== MANIFEST_VERSION) return { valid: false, reason: "unsupported manifest version" };
  if (typeof manifest.signature !== "string") return { valid: false, reason: "missing signature" };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(canonicalManifest(manifest), "utf8"), createPublicKey(publicKeyPem), Buffer.from(manifest.signature, "base64"));
  } catch {
    return { valid: false, reason: "malformed signature or key" };
  }
  if (!ok) return { valid: false, reason: "signature does not match this manifest" };
  return { valid: true, reason: null };
}

/**
 * Decides whether this update may be installed.
 *
 * Refusing a downgrade matters because a signed *old* manifest is still a
 * validly signed manifest — without this check, replaying last year's release
 * is a supported way to reintroduce a fixed vulnerability.
 */
export function decideUpdate({ manifest, installedVersion, publicKeyPem }) {
  const verified = verifyUpdateManifest(manifest, publicKeyPem);
  if (!verified.valid) return { decision: "reject", reason: `The update manifest is not trusted: ${verified.reason}.` };
  if (!SEMVER.test(installedVersion ?? "")) return { decision: "reject", reason: `The installed version '${installedVersion}' is not readable.` };

  const order = compareVersions(manifest.version, installedVersion);
  if (order === 0) return { decision: "skip", reason: `Version ${manifest.version} is already installed.` };
  if (order < 0) return { decision: "reject", reason: `This manifest is for ${manifest.version}, older than the installed ${installedVersion}. Atlas does not downgrade itself.` };
  if (manifest.minimumUpgradeFrom && compareVersions(installedVersion, manifest.minimumUpgradeFrom) < 0) {
    return { decision: "reject", reason: `Upgrading to ${manifest.version} requires at least ${manifest.minimumUpgradeFrom}; this machine has ${installedVersion}.` };
  }
  return { decision: "install", reason: `Upgrading from ${installedVersion} to ${manifest.version}.`, rollbackTo: manifest.rollbackTo ?? installedVersion };
}

/** Confirms a downloaded file is the file the signed manifest describes. */
export function verifyArtifact({ manifest, name, bytes }) {
  const artifact = manifest.artifacts.find((entry) => entry.name === name);
  if (!artifact) return { valid: false, reason: `The manifest does not list an artifact named '${name}'.` };
  if (artifact.bytes !== bytes.length) return { valid: false, reason: `'${name}' is ${bytes.length} bytes; the manifest says ${artifact.bytes}.` };
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) return { valid: false, reason: `'${name}' does not match its SHA-256 digest.` };
  return { valid: true, reason: null };
}

export function compareVersions(left, right) {
  const parse = (value) => String(value).split("-")[0].split(".").map(Number);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1;
  }
  // A prerelease sorts before the release it precedes.
  const preLeft = String(left).includes("-");
  const preRight = String(right).includes("-");
  if (preLeft === preRight) return 0;
  return preLeft ? -1 : 1;
}
