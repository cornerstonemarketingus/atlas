import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { treeEntries } from "../../../web/sandbox/tree-manifest.mjs";

/**
 * A local stand-in for the hosted sandbox broker (apps/web/app/api/sandbox):
 * the same HTTP API and status codes, with each "sandbox" a temporary folder
 * and each snapshot a copy of it. The tree comes from the real in-sandbox
 * helper (apps/web/sandbox/tree-manifest.mjs), so digests are computed the
 * way production computes them.
 *
 * Knobs for failure tests: `token`, `unavailable` (503 with a reason),
 * `delayMs`, `tamperOnRestore`, `echoAuthorization` (an error that repeats the
 * credential, to prove the client scrubs it).
 */
export async function startFakeBroker({ token, unavailable = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atlas-fake-broker-"));
  const state = { requests: [], writes: [], sandboxes: new Map(), backups: new Map(), delayMs: 0, tamperOnRestore: false, echoAuthorization: false, unavailable };
  const folderOf = (name) => join(root, "sandboxes", name);

  function confined(base, path) {
    const target = resolve(base, String(path));
    if (!String(path) || String(path).startsWith("/") || !target.startsWith(base + sep) || target.slice(base.length + 1).split(sep)[0] === ".git") return null;
    return target;
  }

  async function handle(request, body) {
    const url = new URL(request.url, "http://broker");
    const match = /^\/api\/sandbox\/([^/]+)(?:\/([a-z]+))?$/u.exec(url.pathname);
    if (!match) return [404, { code: "NOT_FOUND", message: "no route" }];
    if (request.headers.authorization !== `Bearer ${token}`) {
      return [401, { code: "UNAUTHORIZED", message: state.echoAuthorization ? `Bad credential ${request.headers.authorization}` : "Sign in is required." }];
    }
    if (state.unavailable) return [503, { code: "UNAVAILABLE", message: "Cloud environments are off on this deployment. They need the Cloudflare Workers Paid plan ... and a deploy of the Worker." }];
    const [, id, operation] = match;
    const name = `t1-${id}`;
    const folder = folderOf(name);
    const exists = state.sandboxes.has(name);
    const method = request.method;
    if (!operation && method === "GET") return [200, exists ? { exists: true, name } : { exists: false }];
    if (!operation && method === "POST") {
      if (exists && body.fresh) return [409, { code: "EXISTS", message: "That sandbox already exists." }];
      if (!exists) { mkdirSync(folder, { recursive: true }); state.sandboxes.set(name, { internet: body.internet === true }); }
      return [200, { exists: true, name, internet: state.sandboxes.get(name).internet, running: true }];
    }
    if (!operation && method === "DELETE") {
      rmSync(folder, { recursive: true, force: true });
      const had = state.sandboxes.delete(name);
      return [200, { destroyed: had, snapshotsKept: true }];
    }
    if (operation === "restore" && method === "POST") {
      if (exists) return [409, { code: "EXISTS", message: "A restore needs a fresh sandbox." }];
      const stored = state.backups.get(body.backup?.id);
      if (!stored || stored.record.sha256 !== body.backup.sha256) return [404, { code: "BACKUP_NOT_FOUND", message: "No such backup." }];
      cpSync(stored.folder, folder, { recursive: true });
      state.sandboxes.set(name, { internet: false });
      if (state.tamperOnRestore) writeFileSync(join(folder, "src", "app.mjs"), "export const answer = () => 41;\n");
      return [200, { entries: treeEntries(folder) }];
    }
    if (!exists) return [404, { code: "NOT_FOUND", message: "There is no such sandbox." }];
    if (operation === "exec" && method === "POST") {
      const result = await new Promise((done) => execFile(body.argv[0], body.argv.slice(1), { cwd: folder, timeout: body.timeoutMs, maxBuffer: body.maxOutputBytes ?? 1 << 20 }, (error, stdout, stderr) => {
        done({ exitCode: error ? (typeof error.code === "number" ? error.code : 124) : 0, stdout, stderr, timedOut: Boolean(error?.killed), truncated: { stdout: false, stderr: false } });
      }));
      return [200, result];
    }
    if (operation === "files" && method === "GET") {
      const target = confined(folder, url.searchParams.get("path"));
      if (!target) return [400, { code: "UNSAFE_PATH", message: "outside" }];
      if (!existsSync(target)) return [404, { code: "NOT_A_FILE", message: "missing" }];
      const bytes = readFileSync(target);
      return [200, { path: url.searchParams.get("path"), size: bytes.length, contentBase64: bytes.toString("base64") }];
    }
    if (operation === "files" && method === "PUT") {
      const target = confined(folder, body.path);
      if (!target) return [400, { code: "UNSAFE_PATH", message: "outside" }];
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(body.contentBase64, "base64"));
      state.writes.push({ sandbox: name, path: body.path, executable: body.executable });
      if (typeof body.executable === "boolean") chmodSync(target, body.executable ? 0o755 : 0o644);
      return [200, { path: body.path }];
    }
    if (operation === "tree" && method === "GET") return [200, { entries: treeEntries(folder) }];
    if (operation === "snapshot" && method === "POST") {
      const backupId = randomUUID();
      const copy = join(root, "backups", backupId);
      cpSync(folder, copy, { recursive: true });
      const record = { id: backupId, dir: "/workspace/project", size: 1, sha256: createHash("sha256").update(backupId).digest("hex"), format: "tar+zstd/1" };
      state.backups.set(backupId, { record, folder: copy });
      return [200, { backup: record, entries: treeEntries(folder) }];
    }
    return [404, { code: "NOT_FOUND", message: "There is no such sandbox operation." }];
  }

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      state.requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      if (state.delayMs) await new Promise((done) => setTimeout(done, state.delayMs));
      let status;
      let payload;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        [status, payload] = await handle(request, text ? JSON.parse(text) : {});
      } catch (error) {
        [status, payload] = [500, { code: "BROKER_ERROR", message: String(error?.message ?? error) }];
      }
      if (response.destroyed) return;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, state, folderOf,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
