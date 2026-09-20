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
  const names = new Set();
  for (const artifact of artifacts) {
    if (!/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? "")) throw new ManifestError("BAD_DIGEST", `Artifact '${artifact.name}' needs a SHA-256 digest.`);
    // A missing byte count does not fail here -- JSON.stringify drops an
    // undefined field, so it would simply vanish from the signed form and
    // `verifyArtifact` would then reject that artifact on every machine,
    // forever, with the release already signed and published.
    if (!Number.isInteger(artifact.bytes) || artifact.bytes < 0) {
      throw new ManifestError("BAD_SIZE", `Artifact '${artifact.name}' needs a byte count; got ${JSON.stringify(artifact.bytes)}.`);
    }
    // `verifyArtifact` looks a name up and checks the first match, so a second
    // artifact sharing a name would never be verified against anything.
    if (names.has(artifact.name)) throw new ManifestError("DUPLICATE_ARTIFACT", `Two artifacts are both named '${artifact.name}'.`);
    names.add(artifact.name);
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

/**
 * Semantic version precedence, prereleases included.
 *
 * Two prereleases of the same version used to compare equal, so every
 * `1.0.0-rc.1` to `1.0.0-rc.2` upgrade was reported as "already installed"
 * and declined: a beta channel could not ship an update at all. Prerelease
 * identifiers are compared the way the specification says -- field by field,
 * numerically where both fields are numeric, and a version with more fields
 * winning when everything before them is equal.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.release[index] !== b.release[index]) return a.release[index] < b.release[index] ? -1 : 1;
  }
  // A prerelease has lower precedence than the release it precedes.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length > 0 ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const one = a.prerelease[index];
    const other = b.prerelease[index];
    // Running out of fields first loses: 1.0.0-rc < 1.0.0-rc.1.
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    const oneNumeric = /^\d+$/u.test(one);
    const otherNumeric = /^\d+$/u.test(other);
    // Numeric fields compare as numbers, so rc.9 comes before rc.10 rather
    // than after it, and a numeric field always loses to an alphanumeric one.
    if (oneNumeric && otherNumeric) {
      if (Number(one) !== Number(other)) return Number(one) < Number(other) ? -1 : 1;
    } else if (oneNumeric !== otherNumeric) {
      return oneNumeric ? -1 : 1;
    } else if (one !== other) {
      return one < other ? -1 : 1;
    }
  }
  return 0;
}

function parseVersion(value) {
  const text = String(value);
  const dash = text.indexOf("-");
  const releaseText = dash === -1 ? text : text.slice(0, dash);
  const prereleaseText = dash === -1 ? "" : text.slice(dash + 1);
  const release = releaseText.split(".").map((part) => Number(part) || 0);
  return {
    release: [release[0] ?? 0, release[1] ?? 0, release[2] ?? 0],
    prerelease: prereleaseText.length > 0 ? prereleaseText.split(".") : [],
  };
}
