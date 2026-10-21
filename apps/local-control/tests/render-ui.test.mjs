import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { ArtifactStore } from "../src/platform/artifacts/index.mjs";
import { RenderRunner, validateRenderJob } from "../src/platform/render/index.mjs";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { LOCAL_UI_HTML, LOCAL_UI_JS } from "../src/ui.mjs";

/**
 * The Build page's "Render a clip" panel (issues #352/#354), driven by the
 * daemon's real HTTP handler. The panel's markup and preset jobs are pure
 * functions inside the console script; these tests run that exact code
 * against real /v1/render, /v1/identity, /v1/render/jobs and /v1/artifacts
 * responses. The container runtime is a stand-in, as in sprint-journey.test.mjs.
 * A real-browser pass runs when ATLAS_TEST_PLAYWRIGHT points at Playwright.
 */
const TOKEN = "render-ui-owner-token-0123456789abcdefghijklmnop";
const PHONE_TOKEN = "render-ui-phone-token-0123456789abcdefghijklmnop";
const owner = { authorization: `Bearer ${TOKEN}` };
const phone = { authorization: `Bearer ${PHONE_TOKEN}` };
const SANDBOX = Object.freeze({ runtime: "/usr/bin/docker", image: "node:22-bookworm-slim", cpus: 1, memoryBytes: 512 * 1024 ** 2, pidsLimit: 64, tmpfsBytes: 16 * 1024 ** 2 });
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64, 7)]);
const HOSTILE_NAME = `<img src=x onerror="window.bad=1"> Joe's Roofing: http://evil.example`;

/** The console's own helpers plus the pure render block, evaluated as the browser would. */
function consoleRenderApi() {
  const line = (prefix) => {
    const start = LOCAL_UI_JS.indexOf(prefix);
    assert.ok(start >= 0, `console defines ${prefix}`);
    return LOCAL_UI_JS.slice(start, LOCAL_UI_JS.indexOf("\n", start));
  };
  const start = LOCAL_UI_JS.indexOf("/* Render panel (pure)");
  const end = LOCAL_UI_JS.indexOf("/* Render panel (DOM)");
  assert.ok(start > 0 && end > start);
  // The browser's esc() is textContent → innerHTML, which escapes &, < and >.
  const esc = "function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}";
  return new Function(`${esc}\n${line("const pill=")}\n${line("const ARTIFACT_LABELS=")}\n${line("function bytesText(")}\n${line("function artifactName(")}\n${LOCAL_UI_JS.slice(start, end)}
return { renderCaption, refusedCaptionWord, renderJob, renderPanelHtml, renderResultHtml, RENDER_PRESETS, RENDER_SIZES };`)();
}

function containerStandIn() {
  const runs = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    const staging = /source=(.*),target=\/workspace$/u.exec(args[args.indexOf("--mount") + 1] ?? "")?.[1];
    runs.push({ file, args });
    setImmediate(() => {
      const output = join(staging, ...args.at(-1).split("/"));
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, MP4);
      child.emit("close", 0, null);
    });
    return child;
  };
  return { spawn, runs };
}

async function daemon(t, { sandbox = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atlas-render-ui-"));
  const local = new LocalTaskStore(join(root, "local.sqlite"));
  const artifacts = new ArtifactStore({ root: join(root, "artifacts") });
  const genesisStore = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store: genesisStore, policy: () => ({ decision: "allow" }) });
  const container = containerStandIn();
  const render = sandbox
    ? new RenderRunner({ container: { runtime: SANDBOX.runtime }, resolveSandbox: () => SANDBOX, images: { ffmpeg: "atlas/render:test" }, spawn: container.spawn, killContainer: () => true, knownSecrets: [], artifactStore: artifacts })
    : new RenderRunner({ container: undefined, images: { ffmpeg: "atlas/render:test" }, spawn: () => { throw new Error("must not spawn"); }, knownSecrets: [], artifactStore: artifacts });
  const server = createLocalControlServer({ store: local, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), genesis, artifacts, render });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    local.close(); artifacts.close(); genesisStore.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  local.addDevice("Phone", createHash("sha256").update(PHONE_TOKEN).digest("hex"));
  const workspace = join(root, "projects", "p");
  mkdirSync(workspace, { recursive: true });
  const created = await genesis.create("Build a website for my roofing company");
  genesisStore.transition("local", created.id, "scaffolding", { reason: "test workspace", patch: { workspace, name: HOSTILE_NAME } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, headers = owner) => (await fetch(`${origin}${path}`, { headers })).json();
  return { origin, get, container, project: genesis.view(created.id), workspace };
}

/** What the panel shows for a viewer, built from the daemon's real responses. */
async function panelFor(h, headers) {
  const ui = consoleRenderApi();
  const [{ render }, identity, { artifacts }] = await Promise.all([h.get("/v1/render", headers), h.get("/v1/identity", headers), h.get(`/v1/artifacts?runId=${encodeURIComponent(h.project.id)}`, headers)]);
  return ui.renderPanelHtml({ project: h.project, render, role: identity.role, artifacts });
}

test("the console has a render panel on the Build page wired to the render API, under the same CSP", () => {
  assert.ok(LOCAL_UI_HTML.includes('<section id="build-render" class="panel" hidden aria-labelledby="build-render-heading">'));
  assert.doesNotThrow(() => new Function(LOCAL_UI_JS));
  for (const route of ["'/v1/render'", "'/v1/render/jobs'", "'/v1/identity'", "'/v1/artifacts?runId='"]) assert.ok(LOCAL_UI_JS.includes(route), `the panel calls ${route}`);
  assert.ok(LOCAL_UI_JS.includes("loadRenderPanel(v)"), "the project page draws the panel");
  assert.ok(LOCAL_UI_JS.includes("if(view!=='build')clearRenderPanel()"), "leaving Build releases the clip's blob URL");
  assert.equal(/token=/u.test(LOCAL_UI_JS), false, "no token is ever put in a URL");
  assert.doesNotMatch(LOCAL_UI_HTML, /<script(?![^>]*src=)/u, "no inline script");
});

test("every preset builds a job the render policy accepts, and captions cannot reach the filter syntax", () => {
  const ui = consoleRenderApi();
  const captions = [HOSTILE_NAME, "a'b:c,d;e[f]g=h%i\\j", "../../etc/passwd", "file:x data:y pipe:z", "Wait.. what", "", "Café Ünïcode 2026!", "x".repeat(500)];
  for (const preset of Object.keys(ui.RENDER_PRESETS)) {
    for (const size of Object.keys(ui.RENDER_SIZES)) {
      for (const seconds of [1, 3, 5, 10, 999, "nope"]) {
        for (const caption of captions) {
          const job = ui.renderJob(preset, { caption, size, seconds, stamp: "abc123" });
          assert.doesNotThrow(() => validateRenderJob(job), `${preset}/${size}/${seconds}/${caption}`);
          assert.equal(job.tool, "ffmpeg");
          assert.deepEqual(job.inputs, []);
          assert.match(job.outputs[0], /^renders\/[a-z-]+-abc123\.mp4$/u);
        }
      }
    }
  }
  const caption = ui.renderCaption(HOSTILE_NAME);
  assert.doesNotMatch(caption, /[<>'":=\\/,;[\]%]/u);
  assert.equal(ui.renderCaption(""), "Atlas");
  assert.ok(ui.renderCaption("x".repeat(500)).length <= 60);
  assert.equal(ui.refusedCaptionWord("Movie Night"), "movie", "a word the policy refuses is caught before submitting");
  assert.equal(ui.refusedCaptionWord("Roofing and Sons"), null);
  assert.throws(() => validateRenderJob(ui.renderJob("title", { caption: "Movie Night" })), { code: "FILTER_REFUSED" }, "which is why the console checks first");
  assert.throws(() => ui.renderJob("shell", {}), /Unknown render preset/u);
});

test("unavailable: the panel shows the daemon's reason and no form, and nothing runs", async (t) => {
  const h = await daemon(t, { sandbox: false });
  const html = await panelFor(h, owner);
  const { render } = await h.get("/v1/render");
  assert.equal(render.available, false);
  assert.ok(html.includes(render.reason.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")), "the reason is shown");
  assert.match(html, /Rendering is not available on this computer/u);
  assert.match(html, /id="render-recheck"/u);
  assert.doesNotMatch(html, /<form|id="render-start"/u, "no form when rendering is unavailable");
  assert.equal(h.container.runs.length, 0);
});

test("owner: the panel offers presets, a render produces a video artifact and the panel shows and lists it", async (t) => {
  const h = await daemon(t);
  const ui = consoleRenderApi();
  const html = await panelFor(h, owner);
  assert.match(html, /<form id="render-form"/u);
  assert.match(html, /<label for="render-preset">Preset<\/label><select id="render-preset">/u, "controls are labelled");
  assert.match(html, /<button id="render-start">Render<\/button>/u);
  assert.match(html, /id="render-result" role="status" aria-live="polite"/u);
  assert.ok(!html.includes("<img"), "the project name is escaped");
  assert.ok(html.includes(`value="${ui.renderCaption(HOSTILE_NAME).replaceAll("&", "&amp;")}"`), "the caption defaults to the sanitized project name");
  assert.match(html, /Nothing from this project in Artifacts yet/u);

  // Submit exactly what the form submits.
  const job = ui.renderJob("title", { caption: ui.renderCaption(h.project.name), seconds: "5", size: "720p" });
  const response = await fetch(`${h.origin}/v1/render/jobs`, { method: "POST", headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ projectId: h.project.id, job }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(h.container.runs.length, 1);
  const { args } = h.container.runs[0];
  assert.equal(args[args.indexOf("--network") + 1], "none", "the render ran with the network off");
  assert.ok(args.some((a) => a.startsWith("drawtext=text='img src x onerror window.bad 1 Joe s Roofing http evil")), args.join(" "));
  const [file] = body.result.files;
  assert.match(file.path, /^renders\/title-card-[a-z0-9]+\.mp4$/u);
  assert.equal(readFileSync(join(h.workspace, ...file.path.split("/"))).length, MP4.length, "the clip is in the project folder");

  const result = ui.renderResultHtml(response.status, body);
  assert.match(result, /<h4>Rendered<\/h4>/u);
  assert.ok(result.includes(`<a href="#/artifacts/${file.artifact.sha256}">Open in Artifacts</a>`), "the result links the existing viewer");

  // The video the panel then plays (its blob comes from the artifact's content route).
  const { artifact } = await h.get(`/v1/artifacts/${file.artifact.sha256}`);
  assert.equal(artifact.kind, "video");
  assert.equal(artifact.provenance.runId, h.project.id);
  const content = await fetch(`${h.origin}/v1/artifacts/${file.artifact.sha256}/content`, { headers: owner });
  assert.equal(content.headers.get("content-type"), "video/mp4");
  assert.equal(Buffer.from(await content.arrayBuffer()).subarray(4, 12).toString("latin1"), "ftypisom");

  const after = await panelFor(h, owner);
  assert.ok(after.includes(`<a class="card" href="#/artifacts/${file.artifact.sha256}">`), "the project's artifacts list the clip");
  assert.match(after, /<span class="status Video">Video<\/span>/u);
});

test("a failed or refused render shows why, escaped", () => {
  const ui = consoleRenderApi();
  const failed = ui.renderResultHtml(422, { result: { ok: false, status: "failed", error: "ffmpeg exited with 1", logs: { stderr: "<script>bad()</script> Invalid argument" } } });
  assert.match(failed, /The render did not finish: ffmpeg exited with 1/u);
  assert.ok(failed.includes("&lt;script&gt;bad()&lt;/script&gt; Invalid argument"));
  assert.match(ui.renderResultHtml(503, { code: "REQUIRES_CONTAINER_SANDBOX", message: "Rendering requires the container sandbox." }), /Rendering requires the container sandbox\./u);
  assert.match(ui.renderResultHtml(0, {}), /The render request failed \(0\)\./u);
});

test("paired device: the panel shows availability but no form, and the API refuses a render", async (t) => {
  const h = await daemon(t);
  const identity = await h.get("/v1/identity", phone);
  assert.equal(identity.role, "device");
  const html = await panelFor(h, phone);
  assert.match(html, /id="render-owner-only"/u);
  assert.doesNotMatch(html, /<form|id="render-start"/u, "a paired device does not get the form");
  const ui = consoleRenderApi();
  const refused = await fetch(`${h.origin}/v1/render/jobs`, { method: "POST", headers: { ...phone, "content-type": "application/json" }, body: JSON.stringify({ projectId: h.project.id, job: ui.renderJob("bars", {}) }) });
  assert.equal(refused.status, 403);
  assert.equal(h.container.runs.length, 0);
});

test("the render image is pinned by digest, runs as a non-root user and has no entrypoint wrapper", () => {
  const dockerfile = readFileSync(fileURLToPath(new URL("../../../docker/render/Dockerfile", import.meta.url)), "utf8");
  const instructions = dockerfile.split("\n").filter((l) => /^[A-Z]+\s/u.test(l));
  const froms = instructions.filter((l) => l.startsWith("FROM "));
  assert.ok(froms.length >= 1);
  for (const from of froms) assert.match(from, /^FROM [a-z0-9./_-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}(\s|$)/u, "every base image is pinned by digest");
  const user = instructions.filter((l) => l.startsWith("USER ")).at(-1);
  assert.ok(user, "the image sets a USER");
  assert.doesNotMatch(user, /^USER (root|0)(:|\s|$)/u, "the default user is not root");
  assert.equal(instructions.some((l) => l.startsWith("ENTRYPOINT")), false, "the runner passes the tool as the command (entrypointRunsTool=false)");
  assert.equal(instructions.some((l) => /^(EXPOSE|ADD)\s/u.test(l)), false, "no ports and no remote ADD");
  assert.match(dockerfile, /apt-get install[^\n]*\bffmpeg\b[^\n]*\bblender\b/u);
});

let playwright;
try {
  if (process.env.ATLAS_TEST_PLAYWRIGHT) playwright = await import(pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href);
} catch { /* The dependency-free checks above run everywhere. */ }

test("in a browser the owner renders a clip from a project page with the keyboard and it plays there", {
  skip: !playwright && "Configure ATLAS_TEST_PLAYWRIGHT for real-browser acceptance", timeout: 120_000,
}, async (t) => {
  const h = await daemon(t);
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${h.origin}/`);
  await page.evaluate((token) => sessionStorage.setItem("atlas-token", token), TOKEN);
  await page.goto(`${h.origin}/#/build/${h.project.id}`);
  await page.reload();
  await page.locator("#render-form").waitFor();
  assert.equal(await page.locator("img").count(), 0, "the hostile project name did not become markup");
  await page.getByLabel("Preset").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "render-caption");
  await page.getByLabel("Caption (title card)").fill("Spring sale");
  await page.getByLabel("Caption (title card)").press("Enter");
  await page.locator("#render-view video").waitFor({ state: "attached" });
  assert.match(await page.locator("#render-view video").getAttribute("src"), /^blob:/u);
  assert.match(await page.locator("#render-result").textContent(), /Rendered/u);
  await page.waitForFunction(() => document.querySelectorAll('#render-artifacts a.card').length === 1);
  assert.ok(h.container.runs[0].args.some((a) => a.startsWith("drawtext=text='Spring sale'")));
  // The 5-second Build refresh does not tear down the playing clip.
  await page.waitForTimeout(5_500);
  assert.equal(await page.locator("#render-view video").count(), 1);
  assert.equal(await page.evaluate(() => window.bad), undefined);
  const overflow = await page.evaluate(() => [...document.querySelectorAll("#build-render *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).map((el) => el.tagName + "#" + el.id + "." + el.className));
  assert.deepEqual(overflow, [], "the render panel fits a phone screen");
  assert.deepEqual(errors, []);
});
