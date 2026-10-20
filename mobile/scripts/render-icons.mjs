import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const source = (await readFile(new URL("../../apps/web/public/favicon.svg", import.meta.url), "utf8")).replace(/\r\n/gu, "\n");
const mark = source.replace(/^[\s\S]*?<svg[^>]*>/u, "").replace(/<\/svg>\s*$/u, "");
if (!mark.includes('fill="#080F1E"') || !mark.includes('stroke="#67E8F9"')) throw new Error("Review changed brand colors before generating native icons.");
let playwright;
try {
  playwright = process.env.ATLAS_TEST_PLAYWRIGHT
    ? await import(pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href)
    : await import(new URL("../../apps/browser-worker/node_modules/playwright-core/index.mjs", import.meta.url).href);
} catch { throw new Error("Install browser-worker dependencies or set ATLAS_TEST_PLAYWRIGHT to a Playwright entry module."); }
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) });
const files = [];
const hash = value => createHash("sha256").update(value).digest("hex");
async function render(path, size, kind) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  try {
    let drawing = mark;
    let box = 32;
    if (kind === "round") drawing = drawing.replace('<rect width="32" height="32"', '<rect rx="16" width="32" height="32"');
    if (kind === "foreground") {
      drawing = drawing.replace(/<rect width="32" height="32" fill="#080F1E"\s*\/>/u, "");
      drawing = '<g transform="translate(21 21) scale(2.0625)">' + drawing + '</g>';
      box = 108;
    }
    const html = '<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style><svg fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+box+' '+box+'">'+drawing+'</svg>';
    await page.setContent(html);
    const png = await page.screenshot({ type: "png", omitBackground: kind !== "square" });
    if (kind === "square" && png[25] !== 2) throw new Error("Opaque app icons must be RGB PNGs without an alpha channel.");
    await writeFile(new URL(path, root), png);
    files.push({ path, size, kind, sha256: hash(png) });
  } finally { await page.close(); }
}
try {
  await render("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", 1024, "square");
  for (const [density, scale] of [["mdpi",1],["hdpi",1.5],["xhdpi",2],["xxhdpi",3],["xxxhdpi",4]]) {
    const prefix = "android/app/src/main/res/mipmap-" + density + "/";
    await render(prefix + "ic_launcher.png", 48 * scale, "square");
    await render(prefix + "ic_launcher_round.png", 48 * scale, "round");
    await render(prefix + "ic_launcher_foreground.png", 108 * scale, "foreground");
  }
  const manifest = { source: "apps/web/public/favicon.svg", sourceSha256: hash(source), browser: browser.version(), files };
  await writeFile(new URL("icon-manifest.json", root), JSON.stringify(manifest, null, 2) + "\n");
  console.log("Rendered " + files.length + " native icons from the existing Atlas vector.");
} finally { await browser.close(); }
