import assert from "node:assert/strict";
import test from "node:test";

import { assertPublicUrl, classifyUrl, nonPublicReason } from "../src/url-safety.mjs";

const resolveTo = (...addresses) => async () => addresses.map((address) => ({ address }));

test("private, loopback, link-local and metadata addresses are not public", () => {
  for (const [address, reason] of [
    ["127.0.0.1", "loopback"], ["10.1.2.3", "private network"], ["172.20.0.1", "private network"], ["192.168.1.1", "private network"],
    ["169.254.169.254", "link-local / cloud metadata"], ["100.64.0.1", "carrier-grade NAT"], ["0.0.0.0", "this network"],
    ["::1", "loopback"], ["fd00::1", "private network"], ["fe80::1", "link-local"], ["::ffff:127.0.0.1", "loopback"],
  ]) assert.equal(nonPublicReason(address), reason, address);
  for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) assert.equal(nonPublicReason(address), null, address);
});

test("hostnames are judged by every address they resolve to", async () => {
  assert.equal((await classifyUrl("https://example.com/", { resolve: resolveTo("93.184.216.34") })).public, true);
  // DNS rebinding: one private answer among public ones is enough to refuse.
  assert.equal((await classifyUrl("https://evil.example/", { resolve: resolveTo("93.184.216.34", "127.0.0.1") })).public, false);
  assert.equal((await classifyUrl("http://localtest.me/", { resolve: resolveTo("127.0.0.1") })).reason, "loopback");
  assert.equal((await classifyUrl("http://printer.local/", { resolve: resolveTo("93.184.216.34") })).public, false);
  assert.equal((await classifyUrl("http://[::1]:4317/v1/tasks")).reason, "loopback");
  assert.equal((await classifyUrl("http://2130706433/")).public, false, "decimal IPv4 is normalized by URL parsing");
  await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data"), (e) => e.code === "PRIVATE_ADDRESS" && /ATLAS_BROWSER_ALLOW_HOSTS/u.test(e.message));
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), (e) => e.code === "UNSUPPORTED_SCHEME");
  await assert.rejects(assertPublicUrl("https://user:pass@example.com/"), (e) => e.code === "CREDENTIALS_IN_URL");
  await assert.rejects(assertPublicUrl("https://nope.invalid/", { resolve: async () => { throw new Error("ENOTFOUND"); } }), (e) => e.code === "UNRESOLVABLE_HOST");
  assert.equal(await assertPublicUrl("http://192.168.1.10/admin", { allowHosts: ["192.168.1.10"] }), "http://192.168.1.10/admin");
});
