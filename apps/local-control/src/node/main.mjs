#!/usr/bin/env node
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { RenderRunner } from "../platform/render/index.mjs";
import { AtlasNodeAgent, validateDaemonUrl } from "./agent.mjs";

/**
 * atlas-node: lend this machine's CPU (and GPU, if any) to your Atlas.
 *
 *   ATLAS_NODE_TOKEN=... node src/node/main.mjs --daemon https://your-atlas.example --token-env ATLAS_NODE_TOKEN
 *
 * The token comes from the owner (POST /v1/nodes on the daemon) and is read
 * from the named environment variable, never from the command line, so it
 * does not land in shell history or process listings. Rendering uses this
 * machine's container runtime and render images:
 *   ATLAS_TERMINAL_CONTAINER_RUNTIME  absolute path to docker or podman
 *   ATLAS_RENDER_FFMPEG_IMAGE         image that runs ffmpeg
 *   ATLAS_RENDER_BLENDER_IMAGE        image that runs headless Blender (Cycles on CPU works)
 * Without a container runtime the node declares no render capability and is
 * never sent a job: nothing ever runs on the host.
 */

const USAGE = "Usage: node src/node/main.mjs --daemon <https-url> [--token-env ATLAS_NODE_TOKEN] [--work-dir <dir>]";

export function nodeOptionsFromArgs(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: {
    daemon: { type: "string" }, "token-env": { type: "string", default: "ATLAS_NODE_TOKEN" }, "work-dir": { type: "string" }, help: { type: "boolean" },
  }, strict: true });
  if (values.help) return { help: true };
  if (!values.daemon) throw new Error(`--daemon is required.\n${USAGE}`);
  const daemonUrl = validateDaemonUrl(values.daemon).toString();
  const tokenEnv = values["token-env"];
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/u.test(tokenEnv)) throw new Error("--token-env must name an environment variable.");
  const token = env[tokenEnv]?.trim();
  if (!token) throw new Error(`Set the node token in ${tokenEnv} (the owner gets it when adding the node).`);
  const runtime = env.ATLAS_TERMINAL_CONTAINER_RUNTIME?.trim();
  return {
    daemonUrl, token, workRoot: resolve(values["work-dir"] ?? tmpdir()),
    container: runtime ? { runtime } : undefined,
    images: {
      ...(env.ATLAS_RENDER_FFMPEG_IMAGE?.trim() ? { ffmpeg: env.ATLAS_RENDER_FFMPEG_IMAGE.trim() } : {}),
      ...(env.ATLAS_RENDER_BLENDER_IMAGE?.trim() ? { blender: env.ATLAS_RENDER_BLENDER_IMAGE.trim() } : {}),
    },
  };
}

async function main() {
  let options;
  try { options = nodeOptionsFromArgs(); } catch (error) { console.error(error.message); process.exitCode = 2; return; }
  if (options.help) { console.log(USAGE); return; }
  const render = new RenderRunner({ container: options.container, images: options.images, stagingRoot: options.workRoot });
  const status = render.status();
  console.log(`Atlas Node: render ${status.available ? status.capabilities.join(", ") : `unavailable (${status.reason})`}`);
  const agent = new AtlasNodeAgent({ daemonUrl: options.daemonUrl, token: options.token, render, workRoot: options.workRoot, log: (line) => console.log(`Atlas Node: ${line}`) });
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
  const caps = await agent.refreshCapabilities();
  console.log(`Atlas Node: ${caps.cpu?.cores ?? "?"} cores, ${caps.cpu?.memoryGiB ?? "?"} GiB${caps.gpu ? `, GPU ${caps.gpu.vramGb} GB` : ", no GPU (CPU rendering)"}; daemon ${new URL(options.daemonUrl).origin}`);
  const outcome = await agent.run({ signal: controller.signal });
  if (outcome.stopped === "unauthorized") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Atlas Node stopped: ${error.message}`); process.exitCode = 1; });
}
