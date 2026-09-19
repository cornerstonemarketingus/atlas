#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSupervisor } from "../../apps/local-control/src/release/supervisor.mjs";
import { createRotatingLog } from "../../apps/local-control/src/release/log-rotation.mjs";

/**
 * Runs the Atlas daemon under supervision.
 *
 * This is what the Start Menu entry and the Windows service both launch. It
 * restarts a crashed daemon with backoff, gives up on a crash loop rather
 * than pinning the machine, and writes a rotating log so a long-running
 * install cannot fill the disk — which matters more than it sounds, because
 * Atlas fails closed when it cannot write its audit trail.
 */
const atlasRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDirectory = process.env.ATLAS_LOCAL_DATA_DIR || join(homedir(), ".atlas");
const log = await createRotatingLog({ directory: join(dataDirectory, "logs"), name: "atlas" });
const supervisor = createSupervisor();

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

async function runOnce() {
  const startedAtMs = Date.now();
  const child = spawn(process.execPath, [join(atlasRoot, "apps", "local-control", "src", "main.mjs")], {
    cwd: atlasRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrTail = "";
  child.stdout.on("data", (chunk) => log.write(String(chunk).trimEnd()));
  child.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-8_000);
    log.write(String(chunk).trimEnd());
  });
  const forward = () => child.kill("SIGTERM");
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  const [code, signal] = await new Promise((done) => child.on("exit", (exitCode, exitSignal) => done([exitCode, exitSignal])));
  process.off("SIGINT", forward);
  process.off("SIGTERM", forward);
  return { code, signal, startedAtMs, stderrTail };
}

for (;;) {
  const exit = await runOnce();
  if (stopping) {
    await log.write("Atlas was asked to stop.");
    break;
  }
  const decision = supervisor.recordExit(exit);
  await log.write(`${decision.action}: ${decision.reason}`);
  if (decision.action === "stop") break;
  if (decision.action === "give-up") {
    await log.write(JSON.stringify(supervisor.crashReport(exit)));
    console.error(decision.reason);
    console.error(`The last output was written to ${log.path}.`);
    await log.close();
    process.exit(1);
  }
  await new Promise((wake) => setTimeout(wake, decision.delayMs));
}

await log.close();
