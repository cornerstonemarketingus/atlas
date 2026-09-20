import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createUpdateManifest, decideUpdate, verifyUpdateManifest, verifyArtifact, compareVersions, ManifestError } from "../src/release/update-manifest.mjs";
import { createRotatingLog } from "../src/release/log-rotation.mjs";
import { generateSbom, collectComponents, checksumDirectory, parseChecksums } from "../src/release/sbom.mjs";
import { discoverDependencies, describeDependencies, REQUIREMENTS } from "../src/release/dependencies.mjs";
import { createSupervisor } from "../src/release/supervisor.mjs";

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

const artifact = (name, content) => ({ name, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") });

test("an update manifest is signed, verified, and tamper-evident", () => {
  const { publicKeyPem, privateKeyPem } = keys();
  const manifest = createUpdateManifest({
    product: "Atlas",
    version: "1.2.0",
    releasedAt: "2026-05-01T00:00:00Z",
    rollbackTo: "1.1.0",
    artifacts: [artifact("Atlas-1.2.0.msi", "installer bytes")],
    privateKeyPem,
  });

  assert.equal(verifyUpdateManifest(manifest, publicKeyPem).valid, true);

  // Any change to the signed payload invalidates it — including the one an
  // attacker would actually make.
  assert.equal(verifyUpdateManifest({ ...manifest, version: "9.9.9" }, publicKeyPem).valid, false);
  assert.equal(verifyUpdateManifest({ ...manifest, artifacts: [artifact("Atlas-1.2.0.msi", "evil bytes")] }, publicKeyPem).valid, false);
  assert.equal(verifyUpdateManifest({ ...manifest, rollbackTo: "0.0.1" }, publicKeyPem).valid, false);

  // A manifest signed by a different key is not trusted, however well-formed.
  assert.equal(verifyUpdateManifest(manifest, keys().publicKeyPem).valid, false);
  assert.match(verifyUpdateManifest({ ...manifest, signature: undefined }, publicKeyPem).reason, /missing signature/u);

  assert.throws(() => createUpdateManifest({ product: "Atlas", version: "not-a-version", artifacts: [artifact("a", "b")], privateKeyPem }), ManifestError);
  assert.throws(() => createUpdateManifest({ product: "Atlas", version: "1.0.0", artifacts: [], privateKeyPem }), /at least one artifact/u);
  assert.throws(() => createUpdateManifest({ product: "Atlas", version: "1.0.0", artifacts: [{ name: "x", bytes: 1, sha256: "short" }], privateKeyPem }), /SHA-256 digest/u);
});

test("an update is installed, skipped, or refused, and never downgrades", () => {
  const { publicKeyPem, privateKeyPem } = keys();
  const build = (version, extra = {}) => createUpdateManifest({
    product: "Atlas", version, releasedAt: "2026-05-01T00:00:00Z",
    artifacts: [artifact(`Atlas-${version}.msi`, "bytes")], privateKeyPem, ...extra,
  });

  const upgrade = decideUpdate({ manifest: build("1.2.0", { rollbackTo: "1.1.0" }), installedVersion: "1.1.0", publicKeyPem });
  assert.equal(upgrade.decision, "install");
  assert.equal(upgrade.rollbackTo, "1.1.0", "the release states where a failed upgrade returns to");

  assert.equal(decideUpdate({ manifest: build("1.1.0"), installedVersion: "1.1.0", publicKeyPem }).decision, "skip");

  // A validly signed old manifest is still a downgrade, and replaying one is
  // how a fixed vulnerability gets reintroduced.
  const downgrade = decideUpdate({ manifest: build("1.0.0"), installedVersion: "1.1.0", publicKeyPem });
  assert.equal(downgrade.decision, "reject");
  assert.match(downgrade.reason, /does not downgrade itself/u);

  const tooOld = decideUpdate({ manifest: build("2.0.0", { minimumUpgradeFrom: "1.5.0" }), installedVersion: "1.1.0", publicKeyPem });
  assert.equal(tooOld.decision, "reject");
  assert.match(tooOld.reason, /requires at least 1\.5\.0/u);

  assert.equal(decideUpdate({ manifest: build("1.2.0"), installedVersion: "1.1.0", publicKeyPem: keys().publicKeyPem }).decision, "reject");
  // A rollback target the current build cannot parse is a refusal, not a guess.
  assert.equal(decideUpdate({ manifest: build("1.2.0"), installedVersion: "garbage", publicKeyPem }).decision, "reject");

  assert.equal(compareVersions("1.2.0", "1.10.0"), -1, "versions compare numerically, not as strings");
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0"), -1, "a prerelease sorts before its release");
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
});

test("a downloaded artifact is checked against the signed manifest", () => {
  const { privateKeyPem } = keys();
  const manifest = createUpdateManifest({
    product: "Atlas", version: "1.0.0", releasedAt: "2026-01-01T00:00:00Z",
    artifacts: [artifact("Atlas.msi", "the real installer")], privateKeyPem,
  });

  assert.equal(verifyArtifact({ manifest, name: "Atlas.msi", bytes: Buffer.from("the real installer") }).valid, true);
  const swapped = verifyArtifact({ manifest, name: "Atlas.msi", bytes: Buffer.from("a different installer") });
  assert.equal(swapped.valid, false);
  // Length is checked first, so the message names the obvious problem.
  assert.match(swapped.reason, /bytes|SHA-256/u);
  assert.match(verifyArtifact({ manifest, name: "Other.msi", bytes: Buffer.from("x") }).reason, /does not list an artifact/u);
});

test("logs rotate, keep a bounded history, and do not grow without limit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-logs-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const log = await createRotatingLog({ directory, name: "atlas", maxBytes: 400, keep: 3 });
  for (let index = 0; index < 60; index += 1) await log.write(`line ${index} ${"x".repeat(40)}`);
  await log.close();

  const files = await log.files();
  assert.ok(files.includes("atlas.log"));
  assert.ok(files.length <= 4, `expected at most the current log plus 3 rotations, saw ${files.join(", ")}`);
  // Nothing beyond the keep count survives.
  assert.equal(files.includes("atlas.4.log"), false);

  const current = await readFile(join(directory, "atlas.log"), "utf8");
  assert.ok(current.length <= 600, "the live log stays bounded");
  assert.match(current, /^\d{4}-\d{2}-\d{2}T/u, "entries are timestamped");
});

test("the SBOM reflects the dependencies actually declared", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-sbom-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(directory, "apps", "with-deps"), { recursive: true });
  await mkdir(join(directory, "apps", "no-deps"), { recursive: true });
  await writeFile(join(directory, "apps", "with-deps", "package.json"), JSON.stringify({ name: "with-deps", dependencies: { "playwright-core": "1.55.0" }, devDependencies: { typescript: "^5.7.0" } }));
  await writeFile(join(directory, "apps", "no-deps", "package.json"), JSON.stringify({ name: "no-deps" }));

  const sbom = await generateSbom({ root: directory, product: "Atlas", version: "1.0.0" });
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.metadata.component.version, "1.0.0");
  const names = sbom.components.map((component) => component.name);
  assert.deepEqual(names, ["playwright-core", "typescript"]);
  assert.equal(sbom.components.find((component) => component.name === "playwright-core").scope, "required");
  assert.equal(sbom.components.find((component) => component.name === "typescript").scope, "optional");
  assert.match(sbom.components[0].purl, /^pkg:npm\/playwright-core@1\.55\.0$/u);
  assert.ok(sbom.components[0].usedBy[0].includes("with-deps"));

  // A package with no dependencies produces an SBOM that says so, which is
  // how the "no third-party dependencies" claim becomes checkable.
  const empty = await collectComponents(join(directory, "apps", "no-deps"));
  assert.deepEqual(empty, []);
});

test("release checksums are stable, sorted, and parse back", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-sums-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(directory, "nested"), { recursive: true });
  await writeFile(join(directory, "b.txt"), "second");
  await writeFile(join(directory, "a.txt"), "first");
  await writeFile(join(directory, "nested", "c.txt"), "third");

  const sums = await checksumDirectory(directory);
  const lines = sums.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((line) => line.slice(66)), ["a.txt", "b.txt", "nested/c.txt"], "sorted by path, with forward slashes");
  assert.equal(await checksumDirectory(directory), sums, "the same tree produces the same file");

  const parsed = parseChecksums(sums);
  assert.equal(parsed.get("a.txt"), createHash("sha256").update("first").digest("hex"));
  assert.equal(parsed.size, 3);
});

test("the installer discovers dependencies and installs none of them", async () => {
  const present = await discoverDependencies({
    runCommandImpl: async (command) => {
      if (command === "node") return { ok: true, stdout: "v22.11.0\n", stderr: "" };
      if (command === "git") return { ok: true, stdout: "git version 2.44.0\n", stderr: "" };
      return { ok: false, stdout: "", stderr: "not found" };
    },
  });
  assert.equal(present.canInstall, true, "optional pieces missing does not block installation");
  assert.equal(present.installsNothing, true);
  assert.equal(present.results.find((result) => result.id === "node").satisfied, true);
  assert.equal(present.results.find((result) => result.id === "ollama").present, false);

  const described = describeDependencies(present);
  assert.match(described, /Optional: Ollama — not found/u);
  assert.match(described, /Atlas will not install it for you/u);
  assert.match(described, /Atlas can be installed on this machine/u);

  const tooOld = await discoverDependencies({
    runCommandImpl: async (command) => (command === "node" ? { ok: true, stdout: "v18.0.0\n", stderr: "" } : { ok: false, stdout: "", stderr: "" }),
  });
  assert.equal(tooOld.canInstall, false);
  assert.match(describeDependencies(tooOld), /found 18\.0\.0, which is too old/u);
  assert.deepEqual(tooOld.blocking.map((entry) => entry.id), ["node", "git"]);

  // Every requirement tells the operator where to get it themselves.
  for (const requirement of REQUIREMENTS) {
    assert.match(requirement.obtain, /^https:\/\//u);
    assert.ok(requirement.why.length > 0);
  }
});

test("crash recovery backs off and gives up on a crash loop", () => {
  let clock = 0;
  const supervisor = createSupervisor({ now: () => clock });

  const first = supervisor.recordExit({ code: 1, startedAtMs: 0, stderrTail: "boom" });
  assert.equal(first.action, "restart");
  assert.equal(first.delayMs, 1_000);

  clock = 1_000;
  assert.equal(supervisor.recordExit({ code: 1, startedAtMs: 0 }).delayMs, 2_000, "the delay backs off");
  clock = 2_000;
  assert.equal(supervisor.recordExit({ code: 1, startedAtMs: 0 }).delayMs, 4_000);
  clock = 3_000;
  assert.equal(supervisor.recordExit({ code: 1, startedAtMs: 0 }).delayMs, 8_000);

  clock = 4_000;
  const surrender = supervisor.recordExit({ code: 1, startedAtMs: 0, stderrTail: "Error: listen EADDRINUSE" });
  assert.equal(surrender.action, "give-up");
  assert.match(surrender.reason, /startup failure, not a transient one/u);
  assert.match(surrender.diagnostic, /EADDRINUSE/u);
});

test("a run that stayed up clears the crash history, and a clean exit stops", () => {
  let clock = 0;
  const supervisor = createSupervisor({ now: () => clock });
  for (let index = 0; index < 4; index += 1) {
    clock += 500;
    supervisor.recordExit({ code: 1, startedAtMs: clock - 400 });
  }
  assert.equal(supervisor.recentCrashes, 4);

  // Two minutes of healthy running means whatever happens next is not a
  // startup failure.
  clock += 200_000;
  const afterHealthy = supervisor.recordExit({ code: 1, startedAtMs: clock - 150_000 });
  assert.equal(afterHealthy.action, "restart");
  assert.equal(supervisor.recentCrashes, 1);

  assert.equal(supervisor.recordExit({ code: 0, startedAtMs: clock }).action, "stop");
  assert.equal(supervisor.recentCrashes, 0);
});

test("a crash report carries the diagnostic but not a credential", () => {
  const supervisor = createSupervisor({ now: () => 10_000 });
  const report = supervisor.crashReport({
    code: 1,
    signal: null,
    startedAtMs: 4_000,
    stderrTail: "Error: request failed\n  authorization: Bearer ghp_abcdefghijklmnopqrst\n  at Object.<anonymous>",
  });
  assert.equal(report.ranForSeconds, 6);
  assert.equal(report.exit, "code 1");
  assert.match(report.diagnostic, /request failed/u);
  assert.equal(report.diagnostic.includes("ghp_abcdefghijklmnopqrst"), false);
  assert.match(report.diagnostic, /\[redacted\]/u);
});


test("the Windows installer source is well-formed and preserves operator data", async () => {
  const { readFile: read } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const wxs = await read(join(root, "installer", "windows", "Atlas.wxs"), "utf8");

  // Well-formed enough to fail here rather than in a Windows-only build.
  const tags = [...wxs.matchAll(/<\/?([A-Za-z:]+)[^>]*?(\/?)>/gu)].filter((match) => !match[0].startsWith("<!--") && !match[0].startsWith("<?"));
  const stack = [];
  for (const match of tags) {
    if (match[0].startsWith("</")) {
      assert.equal(stack.pop(), match[1], `mismatched closing tag </${match[1]}>`);
    } else if (match[2] !== "/") {
      stack.push(match[1]);
    }
  }
  assert.deepEqual(stack, [], "every element in Atlas.wxs is closed");

  // A stable UpgradeCode is what makes an upgrade an upgrade rather than a
  // second parallel installation.
  assert.match(wxs, /UpgradeCode="7f3c1f0e-5b3a-4f6d-9a2e-3d1c9b6f4a21"/u);
  assert.match(wxs, /AllowDowngrades="no"/u);
  assert.match(wxs, /ProgramMenuFolder/u, "there is a Start Menu entry");
  assert.match(wxs, /RemoveFolder[^>]*On="uninstall"/u, "uninstall removes what it added");

  // The operator's data directory must not be a component of the package:
  // MSI removes components, and removing this one would delete the encrypted
  // profile and every paired device on uninstall or a failed upgrade.
  assert.equal(/<Component[^>]*Id="[^"]*(Profile|Data|Sessions)[^"]*"/u.test(wxs), false);
  assert.match(wxs, /must never remove the/u, "the reasoning is recorded where the next person will read it");
});

test("the release pipeline is reproducible from the checked-in scripts", async () => {
  const { readFile: read } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  const build = await read(join(root, "scripts", "windows", "Build-AtlasInstaller.ps1"), "utf8");
  assert.match(build, /signtool sign \/fd SHA256/u, "releases are Authenticode signed");
  assert.match(build, /signtool verify/u, "and the signature is verified before the build succeeds");
  assert.match(build, /Public releases must be signed/u, "an unsigned release requires an explicit opt-out");
  assert.match(build, /Remove-Item -Force \$pfx/u, "the certificate does not outlive the build");
  assert.match(build, /node_modules/u, "vendored dependencies are excluded so the SBOM stays honest");
  assert.match(build, /make-release\.mjs/u, "checksums, SBOM and manifest come from the cross-platform script");

  const reporter = await read(join(root, "scripts", "windows", "report-requirements.mjs"), "utf8");
  assert.match(reporter, /Installs nothing/u);
});

test("a prerelease channel can actually ship an update", () => {
  const { publicKeyPem, privateKeyPem } = keys();
  const manifestFor = (version) => createUpdateManifest({
    product: "Atlas",
    version,
    releasedAt: "2026-01-01T00:00:00Z",
    artifacts: [artifact("Atlas.msi", "installer bytes")],
    privateKeyPem,
  });

  // Two prereleases of the same version compared equal, so every rc-to-rc
  // upgrade was declined as "already installed" and a beta channel could
  // not ship anything at all.
  for (const [from, to] of [["1.0.0-rc.1", "1.0.0-rc.2"], ["1.0.0-rc.9", "1.0.0-rc.10"], ["1.0.0-alpha.9", "1.0.0-beta.1"], ["1.0.0-rc", "1.0.0-rc.1"]]) {
    const decision = decideUpdate({ manifest: manifestFor(to), installedVersion: from, publicKeyPem });
    assert.equal(decision.decision, "install", `${from} -> ${to} was ${decision.decision}: ${decision.reason}`);
  }

  // Going the other way is still a downgrade and is still refused.
  assert.equal(decideUpdate({ manifest: manifestFor("1.0.0-rc.1"), installedVersion: "1.0.0-rc.2", publicKeyPem }).decision, "reject");
  assert.equal(decideUpdate({ manifest: manifestFor("1.0.0-rc.2"), installedVersion: "1.0.0-rc.2", publicKeyPem }).decision, "skip");

  // Numeric fields sort as numbers, alphanumeric fields beat numeric ones,
  // and a release beats the prereleases that precede it.
  assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.9"), 1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.1"), 0);
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1);
});

test("a manifest that could never verify is refused before it is signed", () => {
  const { privateKeyPem } = keys();
  const base = { product: "Atlas", version: "1.0.0", releasedAt: "2026-01-01T00:00:00Z", privateKeyPem };

  // JSON.stringify drops an undefined field, so an artifact with no byte
  // count simply vanished from the signed form -- and verifyArtifact then
  // rejected that artifact on every machine, with the release already signed
  // and published.
  assert.throws(
    () => createUpdateManifest({ ...base, artifacts: [{ name: "Atlas.msi", sha256: "a".repeat(64) }] }),
    /needs a byte count/u,
  );
  assert.throws(
    () => createUpdateManifest({ ...base, artifacts: [{ name: "Atlas.msi", bytes: -1, sha256: "a".repeat(64) }] }),
    /needs a byte count/u,
  );

  // verifyArtifact checks the first entry with a given name, so a second one
  // sharing that name would never be verified against anything.
  assert.throws(
    () => createUpdateManifest({
      ...base,
      artifacts: [artifact("Atlas.msi", "one"), artifact("Atlas.msi", "two")],
    }),
    /both named 'Atlas.msi'/u,
  );
});
