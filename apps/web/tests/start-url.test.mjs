import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { literalHostReason, validateStartUrl } from "../app/api/computer/start-url.mjs";

test("hosted start URLs naming loopback, LAN, metadata or local names are refused", () => {
  for (const url of [
    "http://127.0.0.1:4317/", "http://localhost/", "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/", "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/", "http://172.16.5.4/", "http://192.168.1.1/", "http://100.64.0.1/", "http://0.0.0.0/",
    "http://[fd00::1]/", "http://[fe80::1]/", "http://224.0.0.251/", "http://router/", "http://nas.local/",
    "http://metadata.google.internal/", "http://api.localhost/",
  ]) {
    const result = validateStartUrl(url);
    assert.equal(result.ok, false, `${url} must be refused`);
    assert.match(result.message, /public address/u, url);
  }
});

test("non-http schemes and embedded credentials are refused", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/", "not a url"]) {
    assert.match(validateStartUrl(url).message, /http or https/u, url);
  }
  assert.match(validateStartUrl("https://user:pass@example.com/").message, /credentials/u);
});

test("public start URLs pass and are normalized", () => {
  assert.deepEqual(validateStartUrl(" https://Example.com/jobs?q=1 "), { ok: true, url: "https://example.com/jobs?q=1" });
  assert.equal(validateStartUrl("http://8.8.8.8/").ok, true);
  assert.equal(validateStartUrl("https://[2606:4700:4700::1111]/").ok, true);
  assert.equal(literalHostReason("example.com"), null);
});

test("the computer task route validates the start URL with the SSRF policy", () => {
  const source = readFileSync(new URL("../app/api/computer/tasks/route.ts", import.meta.url), "utf8");
  assert.match(source, /validateStartUrl\(body\.startUrl\)/u);
});
