import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export class VisualError extends Error {}
const digest = (text) => createHash("sha256").update(text).digest("hex");

export function visualSourcePath(project) { return containedFile(project.workspace, "site.json"); }

function containedFile(root, name) {
  const base = realpathSync(root);
  const file = realpathSync(resolve(base, name));
  const rel = relative(base, file);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !statSync(file).isFile() || statSync(file).size > 2_000_000) throw new VisualError("Source is outside the project or too large.");
  return file;
}

/** Source identity comes from the template renderer, never from DOM text or a caller-supplied path. */
export function visualSelection(project, key) {
  if (project.plan?.template !== "static-site" || !project.workspace) throw new VisualError("Visual text editing currently supports generated static sites.");
  const match = /^([a-z][a-z0-9-]{0,60}):(headline|intro)$/u.exec(String(key));
  if (!match) throw new VisualError("This element has no supported source mapping.");
  const raw = readFileSync(visualSourcePath(project), "utf8");
  const site = JSON.parse(raw);
  const index = site.pages.findIndex((page) => page.id === match[1]);
  if (index < 0 || typeof site.pages[index][match[2]] !== "string") throw new VisualError("The selected source no longer exists.");
  return { key, file: "site.json", pointer: `/pages/${index}/${match[2]}`, component: "Hero", field: match[2], text: site.pages[index][match[2]], digest: digest(raw), version: project.version };
}

export function visualEdit(project, input) {
  const selection = visualSelection(project, input.key);
  if (input.digest !== selection.digest || input.version !== project.version) throw new VisualError("The project changed. Select the element again before editing.");
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 2000) throw new VisualError("Enter between 1 and 2000 characters.");
  return { selection, edit: { key: selection.key, text: input.text.trim() } };
}

/** Applied by the existing scaffold stage, then checked, tested, built and inspected normally. */
export function applyVisualEdits(content, edits = []) {
  const site = JSON.parse(content);
  for (const edit of edits) {
    const [id, field] = edit.key.split(":");
    const page = site.pages.find((item) => item.id === id);
    if (page && ["headline", "intro"].includes(field)) page[field] = edit.text;
  }
  return `${JSON.stringify(site, null, 2)}\n`;
}

export function pendingVisualContent(project) {
  const content = readFileSync(visualSourcePath(project), "utf8");
  if (digest(content) !== project.spec.visualPending.digest) throw new VisualError("Source changed while the edit was queued. Select it again.");
  return content;
}

/** Read-only design view on its own loopback origin. No daemon token, cookies, APIs or arbitrary proxy target. */
export async function startDesignPreview(project, parentOrigin) {
  visualSelection(project, "home:headline");
  if (!readFileSync(containedFile(project.workspace, "dist/index.html"), "utf8").includes('data-atlas-source="home:headline"')) throw new VisualError("This site predates visual source metadata. Create a new site with the current template to use this editor.");
  const parent = new URL(parentOrigin);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parent.hostname) || parent.protocol !== "http:" || parent.origin !== parentOrigin) throw new VisualError("Open the visual editor from the local Atlas dashboard.");
  const nonce = randomBytes(24).toString("base64");
  const session = randomBytes(24).toString("hex");
  let origin;
  const server = createServer((req, res) => {
    const fail = (status) => { res.writeHead(status); res.end(); };
    if (req.headers.host !== new URL(origin).host) return fail(403);
    if (req.method !== "GET") return fail(405);
    try {
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return fail(403);
      const pathname = decodeURIComponent(url.pathname);
      const name = pathname === "/" ? "index.html" : pathname.slice(1);
      const type = { ".html": "text/html", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp" }[extname(name)];
      if (!type) return fail(404);
      if (name.includes("\\") || name.split("/").some((part) => part === ".." || part === ".")) return fail(404);
      let body = readFileSync(containedFile(project.workspace, `dist/${name}`));
      if (type === "text/html") {
        const script = `document.querySelectorAll('[data-atlas-source]').forEach(el=>el.tabIndex=0);
          function select(e){e.preventDefault();e.stopImmediatePropagation();const el=e.target.closest('[data-atlas-source]');if(!el)return;
          document.querySelector('[data-atlas-selected]')?.removeAttribute('data-atlas-selected');el.setAttribute('data-atlas-selected','true');
          parent.postMessage({type:'atlas:visual-selection',session:${JSON.stringify(session)},key:el.getAttribute('data-atlas-source')},${JSON.stringify(parentOrigin)});}
          document.addEventListener('click',select,true);document.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')select(e)},true);`;
        body = Buffer.from(`${body.toString("utf8")}<style>[data-atlas-source]{cursor:crosshair}[data-atlas-source]:hover,[data-atlas-source]:focus,[data-atlas-selected]{outline:3px solid #2563eb;outline-offset:4px}</style><script nonce="${nonce}">${script}</script>`);
      }
      res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors ${parentOrigin}` });
      res.end(body);
    } catch { fail(404); }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: origin, session, close: () => new Promise((done) => { server.close(done); server.closeAllConnections(); }) };
}
