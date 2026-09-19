import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Bounded logging.
 *
 * A daemon that runs for months writes until the disk is full, and an Atlas
 * that cannot write is an Atlas that cannot audit — which, given the
 * fail-closed rule, means an Atlas that stops working. Rotation is therefore
 * a correctness feature here, not housekeeping.
 */
export async function createRotatingLog({ directory, name = "atlas", maxBytes = 8 * 1024 * 1024, keep = 5 }) {
  await mkdir(directory, { recursive: true });
  const current = join(directory, `${name}.log`);
  let stream = createWriteStream(current, { flags: "a", mode: 0o600 });
  let written = await size(current);

  async function rotate() {
    await stream.close?.();
    stream.end();
    // Oldest first, so nothing is overwritten before it is shifted along.
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = join(directory, `${name}.${index}.log`);
      const to = join(directory, `${name}.${index + 1}.log`);
      await rename(from, to).catch(() => {});
    }
    await rename(current, join(directory, `${name}.1.log`)).catch(() => {});
    await rm(join(directory, `${name}.${keep + 1}.log`), { force: true }).catch(() => {});
    stream = createWriteStream(current, { flags: "a", mode: 0o600 });
    written = 0;
  }

  return {
    path: current,
    async write(line) {
      const entry = `${new Date().toISOString()} ${line}\n`;
      if (written + entry.length > maxBytes) await rotate();
      written += entry.length;
      stream.write(entry);
    },
    async files() {
      const entries = await readdir(directory).catch(() => []);
      return entries.filter((entry) => entry.startsWith(`${name}.`) || entry === `${name}.log`).sort();
    },
    async close() { await new Promise((resolve) => stream.end(resolve)); },
  };
}

async function size(path) {
  const info = await stat(path).catch(() => null);
  return info?.size ?? 0;
}
