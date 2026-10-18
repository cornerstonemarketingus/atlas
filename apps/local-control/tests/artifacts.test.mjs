import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateArtifactRecord } from "../../../packages/atlas-contracts/src/index.mjs";
import { ArtifactStore, parseRange, recordGenesisArtifact } from "../src/platform/artifacts/index.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { LOCAL_UI_HTML, LOCAL_UI_JS } from "../src/ui.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const provenance = { runId: "run-1", step: "render", source: "render" };

/** An MP4-shaped payload: a size word, then the 'ftyp' box type, then data. */
function mp4(seed = "a", size = 4096) {
  const body = Buffer.alloc(size);
  body.writeUInt32BE(24, 0);
  body.write("ftypisom", 4, "latin1");
  for (let i = 12; i < size; i++) body[i] = (i * 31 + seed.charCodeAt(0)) & 0xff;
  return body;
}

/** A valid one-triangle GLB, rotated 90 degrees about Z by its node. */
function triangleGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = Buffer.from(positions.buffer);
  const json = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
  };
  let text = Buffer.from(JSON.stringify(json));
  if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "latin1"); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]);
}

async function tempStore(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atlas-artifacts-"));
  const artifacts = new ArtifactStore({ root, ...options });
  t.after(async () => { artifacts.close(); await rm(root, { recursive: true, force: true }); });
  return { root, artifacts };
}

const blobFiles = (root) => existsSync(join(root, "blobs")) ? readdirSync(join(root, "blobs"), { recursive: true }).filter((name) => /[0-9a-f]{64}$/u.test(name)) : [];

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

test("bytes are addressed by their sha256 and stored once", async (t) => {
  const { root, artifacts } = await tempStore(t);
  const bytes = mp4();
  const first = await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, bytes, name: "intro.mp4" });
  assert.equal(first.created, true);
  assert.equal(first.artifact.sha256, sha(bytes));
  assert.equal(first.artifact.size, bytes.length);
  assert.deepEqual(validateArtifactRecord(first.artifact), [], "the record satisfies the Artifact contract");
  assert.ok(existsSync(join(root, "blobs", sha(bytes).slice(0, 2), sha(bytes))));

  const again = await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance: { runId: "run-2", step: "x" }, bytes });
  assert.equal(again.created, false);
  assert.equal(again.artifact.id, first.artifact.id, "the same bytes are the same artifact");
  assert.equal(again.artifact.provenance.runId, "run-1", "the first provenance is kept");
  assert.equal(artifacts.list("local").length, 1);
  assert.equal(blobFiles(root).length, 1);
  assert.deepEqual(readdirSync(join(root, "tmp")), [], "no partial files are left behind");
});

test("a file is streamed in, hashed and filtered by kind and run", async (t) => {
  const { root, artifacts } = await tempStore(t);
  const source = join(root, "render.mp4");
  const bytes = mp4("b", 300_000);
  await writeFile(source, bytes);
  const { artifact } = await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance: { runId: "render-7", step: "encode" }, path: source });
  assert.equal(artifact.sha256, sha(bytes));
  await artifacts.put({ tenantId: "local", kind: "document", mediaType: "text/markdown", provenance, bytes: "# Notes\n" });
  assert.deepEqual(artifacts.list("local", { kind: "video" }).map((a) => a.sha256), [sha(bytes)]);
  assert.deepEqual(artifacts.list("local", { runId: "render-7" }).map((a) => a.kind), ["video"]);
  assert.equal(artifacts.list("local").length, 2);
  for (const record of artifacts.list("local")) assert.deepEqual(validateArtifactRecord(record), []);
  await assert.rejects(artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, path: join(root, "missing.mp4") }), { code: "INVALID_INPUT" });
  await assert.rejects(artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, path: root }), { code: "INVALID_INPUT" }, "a directory is not a file");
  await assert.rejects(artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, path: source, bytes }), { code: "INVALID_INPUT" });
});

test("tenants never see each other's artifacts, even with identical bytes", async (t) => {
  const { artifacts } = await tempStore(t);
  const bytes = mp4("c");
  const digest = sha(bytes);
  const mine = await artifacts.put({ tenantId: "tenant-a", kind: "video", mediaType: "video/mp4", provenance, bytes });
  assert.equal(artifacts.get("tenant-b", digest), null);
  assert.equal(artifacts.locate("tenant-b", digest), null, "no path to the blob without a row of one's own");
  assert.deepEqual(artifacts.list("tenant-b"), []);
  assert.equal(artifacts.locate("tenant-a", digest).artifact.id, mine.artifact.id);

  const theirs = await artifacts.put({ tenantId: "tenant-b", kind: "video", mediaType: "video/mp4", provenance: { runId: "b-run", step: "s" }, bytes });
  assert.equal(theirs.created, true, "the other tenant gets its own record");
  assert.notEqual(theirs.artifact.id, mine.artifact.id);
  assert.equal(artifacts.get("tenant-a", digest).provenance.runId, "run-1", "and cannot change the first tenant's");
  assert.equal(artifacts.list("tenant-a").length, 1);
  await assert.rejects(artifacts.put({ tenantId: "", kind: "video", mediaType: "video/mp4", provenance, bytes }), { code: "INVALID_TENANT" });
  await assert.rejects(artifacts.put({ tenantId: "../x", kind: "video", mediaType: "video/mp4", provenance, bytes }), { code: "INVALID_TENANT" });
});

test("only allowlisted media types for the declared kind are accepted, before any byte is written", async (t) => {
  const { root, artifacts } = await tempStore(t);
  const refusals = [
    ["file", "text/html", "<script>alert(1)</script>"],
    ["file", "image/svg+xml", "<svg onload='alert(1)'/>"],
    ["file", "application/x-msdownload", Buffer.from("MZ\u0090\u0000")],
    ["file", "application/octet-stream", Buffer.from([1, 2, 3])],
    ["video", "model/gltf-binary", triangleGlb()],
    ["website", "text/html", "<html></html>"],
  ];
  for (const [kind, mediaType, bytes] of refusals) {
    await assert.rejects(artifacts.put({ tenantId: "local", kind, mediaType, provenance, bytes }), { code: "MEDIA_TYPE_NOT_ALLOWED" }, `${kind} ${mediaType}`);
  }
  await assert.rejects(artifacts.put({ tenantId: "local", kind: "hologram", mediaType: "video/mp4", provenance, bytes: mp4() }), { code: "INVALID_KIND" });
  assert.deepEqual(blobFiles(root), [], "nothing was stored");
  assert.deepEqual(artifacts.list("local"), []);
});

test("bytes must look like the declared type", async (t) => {
  const { root, artifacts } = await tempStore(t);
  const cases = [
    ["video", "video/mp4", Buffer.from("MZ this is an executable, not a video")],
    ["video", "video/webm", mp4()],
    ["model3d", "model/gltf-binary", mp4()],
    ["model3d", "model/gltf+json", "{not json"],
    ["document", "text/plain", Buffer.from([0xff, 0xfe, 0x00, 0x41])],
    ["document", "application/pdf", "hello"],
  ];
  for (const [kind, mediaType, bytes] of cases) {
    await assert.rejects(artifacts.put({ tenantId: "local", kind, mediaType, provenance, bytes }), { code: "CONTENT_MISMATCH" }, `${kind} ${mediaType}`);
  }
  assert.deepEqual(blobFiles(root), []);
  const glb = await artifacts.put({ tenantId: "local", kind: "model3d", mediaType: "model/gltf-binary", provenance, bytes: triangleGlb() });
  assert.equal(glb.created, true);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 7)]);
  assert.equal((await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/webm", provenance, bytes: webm })).created, true);
});

test("artifacts over the size limit are refused, from bytes or from a file", async (t) => {
  const { root, artifacts } = await tempStore(t, { maxBytes: 1000, maxTextBytes: 100 });
  await assert.rejects(artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, bytes: mp4("a", 1001) }), { code: "TOO_LARGE" });
  const source = join(root, "big.mp4");
  await writeFile(source, mp4("a", 2000));
  await assert.rejects(artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, path: source }), { code: "TOO_LARGE" });
  await assert.rejects(artifacts.put({ tenantId: "local", kind: "document", mediaType: "text/plain", provenance, bytes: "x".repeat(101) }), { code: "TOO_LARGE" }, "text formats have their own, smaller cap");
  assert.equal((await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, bytes: mp4("a", 1000) })).created, true);
  assert.deepEqual(readdirSync(join(root, "tmp")), []);
});

test("malformed digests never reach the filesystem", async (t) => {
  const { artifacts } = await tempStore(t);
  await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, bytes: mp4() });
  for (const digest of ["../../etc/passwd", "A".repeat(64), `${"a".repeat(63)}/`, "", null, `sha256:${"a".repeat(64)}`]) {
    assert.equal(artifacts.get("local", digest), null);
    assert.equal(artifacts.locate("local", digest), null);
  }
});

test("a ready Genesis project is recorded as a website artifact pointing at its preview", async (t) => {
  const { root, artifacts } = await tempStore(t);
  const workspace = join(root, "project");
  await mkdir(join(workspace, "node_modules", "dep"), { recursive: true });
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "index.html"), "<h1>Roofing</h1>");
  await writeFile(join(workspace, "src", "app.js"), "console.log(1)");
  await writeFile(join(workspace, "node_modules", "dep", "index.js"), "skipped");
  const project = { id: "gen_0123abcd-0000-4000-8000-000000000000", tenantId: "local", name: "Roofing Site", workspace, plan: { template: "static-site" }, spec: { name: "Roofing Site" } };

  const first = await recordGenesisArtifact({ artifacts, project });
  assert.equal(first.created, true);
  assert.equal(first.artifact.kind, "website");
  assert.equal(first.artifact.mediaType, "application/vnd.atlas.site-manifest+json");
  assert.deepEqual(first.artifact.provenance, { runId: project.id, step: "ready", source: "genesis" });
  assert.equal(first.artifact.previewUrl, `/#/build/${project.id}`);
  assert.equal(first.artifact.name, "roofing-site.site.json");
  assert.deepEqual(validateArtifactRecord(first.artifact), []);
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(artifacts.locate("local", first.artifact.sha256).path, "utf8"));
  assert.deepEqual(manifest.files.map((f) => f.path), ["index.html", "src/app.js"], "dependencies are not listed");
  assert.equal(manifest.files[0].sha256, sha("<h1>Roofing</h1>"));

  assert.equal((await recordGenesisArtifact({ artifacts, project })).created, false, "an unchanged project is the same artifact");
  await writeFile(join(workspace, "index.html"), "<h1>Roofing, now with quotes</h1>");
  assert.equal((await recordGenesisArtifact({ artifacts, project })).created, true, "a changed project is a new artifact");
  const app = await recordGenesisArtifact({ artifacts, project: { ...project, id: "gen_0123abcd-0000-4000-8000-000000000001", plan: { template: "web-app" } } });
  assert.equal(app.artifact.kind, "app");
});

test("range headers are parsed strictly", () => {
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=50-1000", 100), { start: 50, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=9-3", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange("bytes=0-1,5-6", 100), null, "several ranges get the whole body");
  assert.equal(parseRange("items=0-1", 100), null);
  assert.equal(parseRange("bytes=-", 100), null);
});

// ---------------------------------------------------------------------------
// HTTP, against the daemon's real handler
// ---------------------------------------------------------------------------

async function daemon(t, { tenantFor } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-artifacts-http-"));
  const store = new LocalTaskStore(join(directory, "local.sqlite"));
  const artifacts = new ArtifactStore({ root: join(directory, "artifacts") });
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), artifacts, ...(tenantFor ? { artifactTenantFor: tenantFor } : {}) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); artifacts.close(); await rm(directory, { recursive: true, force: true }); });
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, port, artifacts, store };
}

const owner = { authorization: `Bearer ${TOKEN}` };

/** Sends the path exactly as written (fetch would normalize dot segments away). */
function rawGet(port, path, headers = owner) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("artifact routes require authentication and list the caller's artifacts", async (t) => {
  const { origin, artifacts } = await daemon(t);
  const video = await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, bytes: mp4() });
  await artifacts.put({ tenantId: "local", kind: "model3d", mediaType: "model/gltf-binary", provenance, bytes: triangleGlb() });
  assert.equal((await fetch(`${origin}/v1/artifacts`)).status, 401);
  assert.equal((await fetch(`${origin}/v1/artifacts/${video.artifact.sha256}/content`)).status, 401, "bytes need the token too");

  const listed = await (await fetch(`${origin}/v1/artifacts`, { headers: owner })).json();
  assert.equal(listed.artifacts.length, 2);
  const videos = await (await fetch(`${origin}/v1/artifacts?kind=video`, { headers: owner })).json();
  assert.deepEqual(videos.artifacts.map((a) => a.sha256), [video.artifact.sha256]);
  assert.equal((await fetch(`${origin}/v1/artifacts?kind=hologram`, { headers: owner })).status, 400);
  const one = await (await fetch(`${origin}/v1/artifacts/${video.artifact.sha256}`, { headers: owner })).json();
  assert.equal(one.artifact.id, video.artifact.id);
  const post = await fetch(`${origin}/v1/artifacts`, { method: "POST", headers: { ...owner, "content-type": "application/json" }, body: "{}" });
  assert.equal(post.status, 405, "nothing is written over HTTP");
});

test("video bytes are served with their type, nosniff, a sandboxing CSP and range support", async (t) => {
  const { origin, artifacts } = await daemon(t);
  const bytes = mp4("v", 10_000);
  const { artifact } = await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, bytes, name: "intro.mp4" });
  const url = `${origin}/v1/artifacts/${artifact.sha256}/content`;

  const full = await fetch(url, { headers: owner });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.equal(full.headers.get("x-content-type-options"), "nosniff");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("content-length"), String(bytes.length));
  assert.match(full.headers.get("content-security-policy"), /default-src 'none'/u);
  assert.match(full.headers.get("content-security-policy"), /sandbox/u);
  assert.match(full.headers.get("content-security-policy"), /media-src 'self'/u);
  assert.match(full.headers.get("content-disposition"), /^inline; filename="intro\.mp4"$/u);
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(bytes));

  const part = await fetch(url, { headers: { ...owner, range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 100-199/${bytes.length}`);
  assert.equal(part.headers.get("content-length"), "100");
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200)));

  const tail = await fetch(url, { headers: { ...owner, range: "bytes=-16" } });
  assert.equal(tail.status, 206);
  assert.ok(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(bytes.length - 16)));

  const open = await fetch(url, { headers: { ...owner, range: "bytes=9990-" } });
  assert.equal(open.status, 206);
  assert.equal(open.headers.get("content-range"), `bytes 9990-9999/${bytes.length}`);
  assert.equal((await open.arrayBuffer()).byteLength, 10);

  const beyond = await fetch(url, { headers: { ...owner, range: `bytes=${bytes.length}-` } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), `bytes */${bytes.length}`);
  await beyond.arrayBuffer();

  const head = await fetch(url, { method: "HEAD", headers: owner });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("non-media artifacts download as attachments under a CSP that loads nothing", async (t) => {
  const { origin, artifacts } = await daemon(t);
  const doc = await artifacts.put({ tenantId: "local", kind: "document", mediaType: "text/markdown", provenance, bytes: "# <script>alert(1)</script>\n" });
  const response = await fetch(`${origin}/v1/artifacts/${doc.artifact.sha256}/content`, { headers: owner });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition"), /^attachment; filename="document-[0-9a-f]{12}\.md"$/u);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /^default-src 'none';/u);
  assert.doesNotMatch(csp, /media-src|img-src|script-src/u);
  const glb = await artifacts.put({ tenantId: "local", kind: "model3d", mediaType: "model/gltf-binary", provenance, bytes: triangleGlb() });
  const model = await fetch(`${origin}/v1/artifacts/${glb.artifact.sha256}/content`, { headers: owner });
  assert.equal(model.headers.get("content-type"), "model/gltf-binary");
  assert.match(model.headers.get("content-disposition"), /^attachment; filename="model3d-[0-9a-f]{12}\.glb"$/u);
  assert.ok(Buffer.from(await model.arrayBuffer()).equals(triangleGlb()));
});

test("bytes are reachable only by digest: traversal and malformed paths are 404", async (t) => {
  const { origin, port, artifacts } = await daemon(t);
  const { artifact } = await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, bytes: mp4() });
  for (const path of [
    "/v1/artifacts/../../../etc/passwd",
    "/v1/artifacts/..%2f..%2f..%2fetc%2fpasswd/content",
    `/v1/artifacts/${artifact.sha256}/../../../local.sqlite`,
    `/v1/artifacts/${artifact.sha256.toUpperCase()}/content`,
    `/v1/artifacts/${artifact.sha256}/content/extra`,
    `/v1/artifacts/${artifact.sha256.slice(0, 2)}/${artifact.sha256}`,
    "/v1/artifacts/blobs",
  ]) {
    const response = await rawGet(port, path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.body, /root:|SQLite format/u);
  }
  assert.equal((await fetch(`${origin}/v1/artifacts/${"0".repeat(64)}/content`, { headers: owner })).status, 404, "unknown digest");
});

test("a paired device in another tenant cannot list, read or fetch the owner's artifacts", async (t) => {
  const { origin, artifacts } = await daemon(t, { tenantFor: (identity) => (identity.role === "admin" ? "local" : `device-${identity.device.id}`) });
  const { artifact } = await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, bytes: mp4("p") });
  const { code } = await (await fetch(`${origin}/v1/pair`, { method: "POST", headers: owner })).json();
  const claimed = await (await fetch(`${origin}/v1/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Phone" }) })).json();
  const device = { authorization: `Bearer ${claimed.deviceToken}` };

  assert.deepEqual((await (await fetch(`${origin}/v1/artifacts`, { headers: device })).json()).artifacts, []);
  assert.equal((await fetch(`${origin}/v1/artifacts/${artifact.sha256}`, { headers: device })).status, 404);
  const bytes = await fetch(`${origin}/v1/artifacts/${artifact.sha256}/content`, { headers: device });
  assert.equal(bytes.status, 404, "another tenant's bytes look exactly like missing bytes");
  await bytes.arrayBuffer();
  // The owner still sees it.
  assert.equal((await fetch(`${origin}/v1/artifacts/${artifact.sha256}/content`, { headers: owner })).status, 200);
});

test("missing bytes on disk are reported, not served empty", async (t) => {
  const { origin, artifacts } = await daemon(t);
  const { artifact } = await artifacts.put({ tenantId: "local", kind: "video", mediaType: "video/mp4", provenance, bytes: mp4("m") });
  await unlink(artifacts.locate("local", artifact.sha256).path);
  assert.equal((await fetch(`${origin}/v1/artifacts/${artifact.sha256}/content`, { headers: owner })).status, 410);
});

test("the daemon answers 503 for artifact routes when no store is running", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-artifacts-none-"));
  const store = new LocalTaskStore(join(directory, "local.sqlite"));
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/v1/artifacts`, { headers: owner })).status, 503);
});

// ---------------------------------------------------------------------------
// Console viewers
// ---------------------------------------------------------------------------

test("the console has an Artifacts view with video, 3D and preview viewers, and blob URLs allowed by its CSP", async (t) => {
  assert.ok(LOCAL_UI_HTML.includes('data-view="artifacts"'));
  assert.ok(LOCAL_UI_HTML.includes('href="#/artifacts"'));
  assert.doesNotThrow(() => new Function(LOCAL_UI_JS));
  assert.ok(LOCAL_UI_JS.includes("document.createElement('video')"), "videos play in a <video> element");
  assert.ok(LOCAL_UI_JS.includes("getContext('webgl'"), "3D models render with WebGL");
  assert.ok(LOCAL_UI_JS.includes("href=\"#/build/'+esc(a.provenance.runId)"), "website and app artifacts open the Genesis preview");
  assert.equal(/token=/u.test(LOCAL_UI_JS), false, "no token is ever put in a URL");
  assert.doesNotMatch(LOCAL_UI_JS, /https?:\/\/(cdn|unpkg|ajax)\./u, "no third-party script is loaded");

  const { origin } = await daemon(t);
  const csp = (await fetch(origin)).headers.get("content-security-policy");
  assert.match(csp, /media-src 'self' blob:/u);
  assert.match(csp, /script-src 'self';/u, "scripts stay same-origin only");
});

test("the console's glTF reader parses a GLB, applies node transforms and computes bounds", () => {
  const start = LOCAL_UI_JS.indexOf("function parseGltf(");
  const end = LOCAL_UI_JS.indexOf("function showModel(");
  assert.ok(start > 0 && end > start);
  const parseGltf = new Function(`${LOCAL_UI_JS.slice(start, end)}; return parseGltf;`)();
  const glb = triangleGlb();
  const model = parseGltf(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), "model/gltf-binary");
  assert.equal(model.triangles, 1);
  assert.equal(model.count, 3);
  // Rotated 90 degrees about Z: (1,0,0) → (0,1,0) and (0,1,0) → (-1,0,0).
  const p = [...model.positions].map((v) => Math.round(v * 1e6) / 1e6 + 0);
  assert.deepEqual(p, [0, 0, 0, 0, 1, 0, -1, 0, 0]);
  assert.deepEqual([...model.normals.slice(0, 3)].map((v) => Math.round(v) + 0), [0, 0, 1]);
  assert.deepEqual(model.center.map((v) => Math.round(v * 1e6) / 1e6 + 0), [-0.5, 0.5, 0]);
  assert.throws(() => parseGltf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]).buffer, "model/gltf-binary"), /not a GLB/u);
  const external = Buffer.from(JSON.stringify({ meshes: [], buffers: [{ uri: "https://example.com/x.bin", byteLength: 1 }] }));
  assert.throws(() => parseGltf(external.buffer.slice(external.byteOffset, external.byteOffset + external.byteLength), "model/gltf+json"), /inside the file/u);
});
