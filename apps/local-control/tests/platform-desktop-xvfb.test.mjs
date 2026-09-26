import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DesktopController,
  DesktopSafetyStore,
  XvfbDisplay,
  createXvfbDriver,
  detectXTools,
  parseXwdHeader,
  pngSize,
  xwdToPng,
} from "../src/platform/desktop/index.mjs";

const tools = detectXTools();
const skipNoXvfb = tools.xvfb ? false : "Xvfb is not installed";

async function waitFor(predicate, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("Xvfb: missing Xvfb is a structured refusal, and a driver needs a running display", async () => {
  const display = new XvfbDisplay({ tools: { xvfb: null } });
  await assert.rejects(display.start(), { code: "UNSUPPORTED" });
  assert.throws(() => createXvfbDriver({ display }), { code: "NO_DISPLAY" });
});

test("XWD parsing rejects non-XWD input", () => {
  assert.equal(parseXwdHeader(Buffer.from("P6\n1 1\n255\n")), null);
  assert.equal(parseXwdHeader(Buffer.alloc(200)), null);
  assert.equal(xwdToPng(Buffer.alloc(200)), null);
});

test("Xvfb lifecycle: private display, real framebuffer screenshots, honest input capability, allowlisted launch, clean stop", { skip: skipNoXvfb, timeout: 30_000 }, async (t) => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "atlas-xvfb-test-"));
  t.after(() => rm(tmpRoot, { recursive: true, force: true }));
  const display = new XvfbDisplay({ tools, screen: "640x480x24", tmpRoot });
  t.after(() => display.stop());
  await display.start();
  const { pid, directory } = display;
  assert.match(display.display, /^:\d+$/);
  assert.ok(alive(pid));
  assert.ok(directory.startsWith(tmpRoot));

  const probeOut = join(tmpRoot, "probe.txt");
  const driver = createXvfbDriver({
    display,
    apps: { probe: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(probeOut)}, process.env.DISPLAY + "|" + process.env.HOME)`] } },
  });
  t.after(() => driver.closeApps());
  const caps = driver.capabilities();
  assert.equal(caps.screenshot, true);
  assert.equal(caps.launch, true);
  assert.equal(caps.input, Boolean(tools.xdotool));
  assert.equal(caps.accessibility, false);
  if (!tools.xdotool) assert.match(caps.reasons.input, /xdotool not found/);
  if (tools.xauth) assert.equal(caps.accessControl, "mit-magic-cookie");

  const store = new DesktopSafetyStore();
  t.after(() => store.close());
  const device = store.enrollDevice({ ownerId: "o", name: "cloud vm", platform: "xvfb" });
  store.approveDevice(device.id, { ownerId: "o" });
  const controller = new DesktopController({ driver, store, deviceId: device.id, allowedApps: ["probe"] });
  const approval = store.requestSessionApproval({ deviceId: device.id, requestedBy: "a", purpose: "probe", scope: { allowedApps: ["probe"] } });
  store.approveSession(approval.id, { decidedBy: "o" });
  const session = await controller.createSession({ approvalId: approval.id });
  assert.equal(driver.indicator.state, "active");

  const shot = await controller.screenshot(session.id);
  assert.match(shot.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(pngSize(store.getScreenshot(shot.digest).bytes), { width: 640, height: 480 });

  if (!tools.xdotool) {
    await assert.rejects(controller.click(session.id, { x: 10, y: 10 }), { code: "UNSUPPORTED" });
    await assert.rejects(controller.typeText(session.id, { text: "x" }), { code: "UNSUPPORTED" });
    await assert.rejects(controller.observe(session.id), { code: "UNSUPPORTED" });
  }
  await assert.rejects(controller.launchApp(session.id, { app: "xterm" }), { code: "APP_NOT_ALLOWLISTED" });
  await controller.launchApp(session.id, { app: "probe" });
  assert.ok(await waitFor(() => existsSync(probeOut)), "the allowlisted app ran");
  const [probeDisplay, probeHome] = (await readFile(probeOut, "utf8")).split("|");
  assert.equal(probeDisplay, display.display);
  assert.ok(probeHome.startsWith(directory), "apps get a private HOME inside the temp dir");

  await controller.stop(session.id);
  assert.equal(driver.indicator.state, "inactive");
  await driver.closeApps();
  await display.stop();
  assert.equal(alive(pid), false, "Xvfb is gone");
  assert.equal(existsSync(directory), false, "the private temp dir is removed");
  assert.equal(driver.capabilities().screenshot, false);
});
