import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { auditBuiltSite, SeoAuditError } from "./seo-audit.mjs";

const command = fileURLToPath(new URL("./seo-audit.mjs", import.meta.url));
const withSite = (run) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-seo-audit-"));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
};
const page = ({ canonical = "https://example.com/", title = "Example", description = "A useful business site.", extra = "", body = "<h1>Example</h1>" } = {}) =>
  `<!doctype html><html><head><title>${title}</title><meta content="${description}" name="description"><link href="${canonical}" rel="canonical">${extra}</head><body>${body}</body></html>`;
function fixture(directory, { html = page(), locations = ["https://example.com/"], robots = "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n" } = {}) {
  writeFileSync(join(directory, "index.html"), html);
  writeFileSync(join(directory, "sitemap.xml"), `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`);
  if (robots !== null) writeFileSync(join(directory, "robots.txt"), robots);
}
const audit = (directory) => auditBuiltSite({ directory, url: "https://example.com" });
const codes = (report) => report.findings.map((finding) => finding.code);

test("a built public site passes via library and JSON CLI without changing files", () => withSite((directory) => {
  fixture(directory);
  const before = readdirSync(directory).map((file) => [file, readFileSync(join(directory, file), "utf8")]);
  const report = audit(directory);
  assert.equal(report.status, "passed");
  assert.equal(report.errors, 0);
  assert.equal(report.warnings, 0);
  assert.equal(report.pages, 1);
  const child = spawnSync(process.execPath, [command, "--directory", directory, "--url", "https://example.com"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), report);
  assert.deepEqual(readdirSync(directory).map((file) => [file, readFileSync(join(directory, file), "utf8")]), before);
}));

test("relative canonical and sitemap locations fail the launch gate", () => withSite((directory) => {
  fixture(directory, { html: page({ canonical: "/" }), locations: ["/"], robots: "User-agent: *\nSitemap: /sitemap.xml\n" });
  const report = audit(directory);
  assert.equal(report.status, "needs-work");
  assert.ok(codes(report).includes("CANONICAL_INVALID"));
  assert.ok(codes(report).includes("SITEMAP_URL_INVALID"));
  assert.ok(codes(report).includes("ROBOTS_SITEMAP"));
  const child = spawnSync(process.execPath, [command, "--url", "https://example.com", "--directory", directory], { encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).status, "needs-work");
}));

test("off-origin, credentialed and fragment URLs are refused without echoing them", () => {
  for (const canonical of ["https://preview.example.com/", "https://user:secret@example.com/", "https://example.com/#fragment", "//example.com/", "javascript:alert(1)"]) {
    withSite((directory) => {
      fixture(directory, { html: page({ canonical }), locations: [canonical] });
      const report = audit(directory);
      assert.ok(codes(report).includes("CANONICAL_INVALID"), canonical);
      assert.ok(codes(report).includes("SITEMAP_URL_INVALID"), canonical);
      assert.ok(!JSON.stringify(report).includes(canonical), "untrusted URLs are not printed");
    });
  }
});

test("canonicals must agree with sitemap; duplicate signals are visible", () => withSite((directory) => {
  fixture(directory, { locations: ["https://example.com/about.html", "https://example.com/about.html"] });
  writeFileSync(join(directory, "about.html"), page());
  const report = audit(directory);
  assert.ok(codes(report).includes("SITEMAP_CANONICAL_MISSING"));
  assert.ok(codes(report).includes("SITEMAP_DUPLICATE"));
  assert.ok(codes(report).includes("CANONICAL_SHARED"));
  assert.ok(codes(report).includes("TITLE_DUPLICATE"));
}));

test("noindex in the body is a launch blocker; comments and scripts are not metadata", () => withSite((directory) => {
  fixture(directory, { html: page({ extra: "<!-- <meta name='robots' content='noindex'> --><script>const tag = \"<meta name='robots' content='noindex'>\";</script>" }) });
  assert.ok(!codes(audit(directory)).includes("NOINDEX"));
  writeFileSync(join(directory, "index.html"), page({ body: "<h1>Example</h1><meta name='GOOGLEBOT' content='follow, noindex'>" }));
  assert.ok(codes(audit(directory)).includes("NOINDEX"));
  writeFileSync(join(directory, "index.html"), page({ extra: "<meta name=robots content=none>" }));
  assert.ok(codes(audit(directory)).includes("NOINDEX"));
}));

test("missing and multiple canonicals fail; incomplete descriptions and robots files warn", () => withSite((directory) => {
  fixture(directory, { html: page({ description: "", extra: "<link rel='canonical' href='https://example.com/'>" }), robots: null });
  assert.ok(codes(audit(directory)).includes("CANONICAL_COUNT"));
  assert.ok(codes(audit(directory)).includes("DESCRIPTION_MISSING"));
  assert.ok(codes(audit(directory)).includes("ROBOTS_MISSING"));
  writeFileSync(join(directory, "index.html"), "<html><head><title>Example</title></head><body><h1>Example</h1></body></html>");
  assert.ok(codes(audit(directory)).includes("CANONICAL_COUNT"));
}));

test("XML entities preserve matching canonical and sitemap query strings", () => withSite((directory) => {
  fixture(directory, { html: page({ canonical: "https://example.com/?a=1&amp;b=2" }), locations: ["https://example.com/?a=1&amp;b=2"] });
  assert.equal(audit(directory).errors, 0);
}));

test("empty builds and sitemap indexes do not produce a successful audit", () => withSite((directory) => {
  assert.ok(codes(audit(directory)).includes("NO_PAGES"));
  fixture(directory);
  writeFileSync(join(directory, "sitemap.xml"), "<sitemapindex><sitemap><loc>https://example.com/part.xml</loc></sitemap></sitemapindex>");
  assert.ok(codes(audit(directory)).includes("SITEMAP_FORMAT"));
}));

test("invalid origin/arguments and oversized/deep builds stop with a bounded failure", () => withSite((directory) => {
  fixture(directory);
  for (const url of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?x=1", "https://example.com/#x"]) {
    assert.throws(() => auditBuiltSite({ directory, url }), SeoAuditError);
  }
  for (const args of [[], ["--bad"], ["--directory", directory, "--url", "https://example.com", "--url", "https://example.com"]]) {
    const child = spawnSync(process.execPath, [command, ...args], { encoding: "utf8" });
    assert.equal(child.status, 2);
    assert.equal(child.stdout, "");
  }
  writeFileSync(join(directory, "huge.html"), "x".repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => audit(directory), /file-size limit/u);
  rmSync(join(directory, "huge.html"));
  let deep = directory;
  for (let index = 0; index < 9; index++) { deep = join(deep, "nested"); mkdirSync(deep); }
  assert.throws(() => audit(directory), /directory-depth limit/u);
}));

test("symlinks cannot pull an external document into the audit", (context) => withSite((directory) => {
  fixture(directory);
  const external = mkdtempSync(join(tmpdir(), "atlas-seo-external-"));
  try {
    writeFileSync(join(external, "private.html"), page());
    try { symlinkSync(join(external, "private.html"), join(directory, "linked.html")); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { context.skip("Host cannot create file symlinks."); return; } throw error; }
    assert.throws(() => audit(directory), /symbolic link/u);
  } finally { rmSync(external, { recursive: true, force: true }); }
}));

test("the current Genesis renderer's relative SEO output is detected on a real build", () => withSite((directory) => {
  const template = fileURLToPath(new URL("../../apps/local-control/src/platform/genesis/templates/static-site/files/", import.meta.url));
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "src"));
  for (const file of ["scripts/build.mjs", "src/styles.css", "src/contact.js"]) copyFileSync(join(template, file), join(directory, file));
  writeFileSync(join(directory, "site.json"), JSON.stringify({ name: "Example", tagline: "Services", cta: "Contact us", contact: {}, pages: [{ id: "home", title: "Home", headline: "Example services", intro: "Useful work", description: "Services from Example", sections: [] }] }));
  const result = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(directory, "dist", "index.html")));
  const report = auditBuiltSite({ directory: join(directory, "dist"), url: "https://example.com" });
  assert.ok(codes(report).includes("CANONICAL_INVALID"));
  assert.ok(codes(report).includes("SITEMAP_URL_INVALID"));
}));
