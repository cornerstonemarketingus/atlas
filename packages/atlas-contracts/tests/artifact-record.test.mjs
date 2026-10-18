import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_ALLOWED_MEDIA_TYPES, ARTIFACT_KINDS, ARTIFACT_MEDIA_TYPES, SCHEMA_VERSION, assertArtifactRecord, newId,
  validateArtifactRecord,
} from "../src/index.mjs";

const record = (overrides = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  id: newId("artifact"),
  tenantId: "local",
  kind: "video",
  sha256: "a".repeat(64),
  size: 1024,
  mediaType: "video/mp4",
  provenance: { runId: "run-1", step: "render" },
  createdAt: "2026-10-18T12:00:00.000Z",
  ...overrides,
});

const paths = (value) => validateArtifactRecord(value).map((error) => error.path).sort();

test("a well-formed artifact record of every kind validates", () => {
  for (const kind of ARTIFACT_KINDS) {
    const mediaType = ARTIFACT_MEDIA_TYPES[kind][0];
    assert.deepEqual(validateArtifactRecord(record({ kind, mediaType })), [], kind);
  }
  assert.deepEqual(validateArtifactRecord(record({ previewUrl: "/#/build/gen_1", name: "clip.mp4" })), []);
  assert.deepEqual(validateArtifactRecord(record({ previewUrl: "http://127.0.0.1:5173", provenance: { runId: "r", step: "s", source: "genesis" } })), []);
  assert.equal(assertArtifactRecord(record()).kind, "video");
});

test("required fields, the schema version and closed properties are enforced", () => {
  const { sha256, ...missing } = record();
  assert.ok(sha256);
  assert.deepEqual(paths(missing), ["$.sha256"]);
  assert.deepEqual(paths(record({ schemaVersion: "atlas.v0" })), ["$.schemaVersion"]);
  assert.deepEqual(paths(record({ extra: true })), ["$.extra"]);
  assert.deepEqual(paths(record({ provenance: { runId: "r" } })), ["$.provenance.step"]);
  assert.deepEqual(paths(record({ provenance: { runId: "r", step: "s", by: "x" } })), ["$.provenance.by"]);
  assert.throws(() => assertArtifactRecord(record({ kind: "hologram" })), { code: "SCHEMA_VIOLATION" });
});

test("digests are bare lowercase sha256 hex and sizes are whole bytes", () => {
  assert.deepEqual(paths(record({ sha256: "A".repeat(64) })), ["$.sha256"]);
  assert.deepEqual(paths(record({ sha256: `sha256:${"a".repeat(64)}` })), ["$.sha256"]);
  assert.deepEqual(paths(record({ sha256: "../../etc/passwd" })), ["$.sha256"]);
  assert.deepEqual(paths(record({ size: -1 })), ["$.size"]);
  assert.deepEqual(paths(record({ size: 1.5 })), ["$.size"]);
  assert.deepEqual(paths(record({ id: "art_nothex" })), ["$.id"]);
});

test("unknown media types and kind/media-type mismatches are refused", () => {
  assert.deepEqual(paths(record({ mediaType: "text/html" })), ["$.mediaType"]);
  assert.deepEqual(paths(record({ mediaType: "image/svg+xml" })), ["$.mediaType"]);
  assert.deepEqual(paths(record({ mediaType: "application/octet-stream" })), ["$.mediaType"]);
  assert.equal(ARTIFACT_ALLOWED_MEDIA_TYPES.includes("text/html"), false, "HTML can carry script and is never stored");
  // Allowed somewhere, but not for this kind.
  const mismatch = validateArtifactRecord(record({ kind: "video", mediaType: "model/gltf-binary" }));
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].path, "$.mediaType");
  assert.match(mismatch[0].message, /not allowed for kind 'video'/u);
});

test("preview URLs are same-origin paths or http(s) only, and names carry no path", () => {
  for (const previewUrl of ["javascript:alert(1)", "data:text/html,x", "//evil.example/x", "file:///etc/passwd", "/ok path"]) {
    assert.deepEqual(paths(record({ previewUrl })), ["$.previewUrl"], previewUrl);
  }
  for (const name of ["../x.mp4", "a/b.mp4", "a\\b.mp4", "line\nbreak.mp4", ""]) {
    assert.deepEqual([...new Set(paths(record({ name })))], ["$.name"], JSON.stringify(name));
  }
  assert.deepEqual(validateArtifactRecord(record({ previewUrl: null, name: null })), []);
});
