import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

// Cloudflare Workers does not implement the Fetch standard's redirect "error"
// mode: fetch(url, { redirect: "error" }) throws a TypeError before anything
// is sent. Every GitHub dispatch, run claim and cancellation from the hosted
// app failed that way. Worker code uses "manual" and checks response.ok.
async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:mjs|js|ts|tsx)$/u.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

test("no Worker code asks fetch for the redirect mode Workers does not implement", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const offenders = [];
  for (const directory of ["app", "worker", "db"]) {
    for (const file of await sources(join(root, directory))) {
      if (/redirect:\s*["']error["']/u.test(await readFile(file, "utf8"))) offenders.push(relative(root, file).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(offenders, []);
});
