import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Serves tests/fixtures plus a few dynamic routes on 127.0.0.1:<random>. */
export async function startServer({ otherOrigin = null } = {}) {
  const hits = [];
  const server = createServer(async (req, res) => {
    hits.push(req.url);
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/redirect" && otherOrigin) {
      res.writeHead(302, { location: `${otherOrigin}/landing` }).end();
      return;
    }
    if (path === "/beacon.html" && otherOrigin) {
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<!doctype html><title>Beacon</title><img alt="t" src="${otherOrigin}/tracker.png"><script>fetch("${otherOrigin}/exfil").catch(()=>{})</script><a href="${otherOrigin}/elsewhere">Offsite</a><a href="#" onclick="setTimeout(() => { location.href = '${otherOrigin}/later'; }, 150); return false;">Delayed offsite</a>`,
      );
      return;
    }
    const file = normalize(join(FIXTURES, path === "/" ? "index.html" : path));
    if (!file.startsWith(FIXTURES)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, hits, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Launch guard: skip only when explicitly asked to, otherwise fail loudly. */
export const skipBrowser = process.env.ATLAS_BROWSER_TESTS === "skip"
  ? "ATLAS_BROWSER_TESTS=skip: Chromium-dependent tests skipped by request"
  : false;
