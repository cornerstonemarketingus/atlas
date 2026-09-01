import assert from "node:assert/strict";
import test from "node:test";
import { signSession, verifySession, sessionCookieHeader, clearSessionCookieHeader, readSessionCookie } from "../app/api/auth/session.mjs";

test("round-trips a signed session payload", async () => {
  const token = await signSession({ uid: 7, gh: "octocat" }, "secret");
  const payload = await verifySession(token, "secret");
  assert.equal(payload.uid, 7);
  assert.equal(payload.gh, "octocat");
});

test("rejects a token signed with a different secret", async () => {
  const token = await signSession({ uid: 7, gh: "octocat" }, "secret");
  assert.equal(await verifySession(token, "other-secret"), null);
});

test("rejects an expired token", async () => {
  const issuedLongAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const token = await signSession({ uid: 7, gh: "octocat" }, "secret", issuedLongAgo);
  assert.equal(await verifySession(token, "secret"), null);
});

test("rejects a tampered payload segment", async () => {
  const token = await signSession({ uid: 7, gh: "octocat" }, "secret");
  const [header, , signature] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ uid: 1, gh: "attacker", iat: 0, exp: 9_999_999_999 })).toString("base64url");
  assert.equal(await verifySession(`${header}.${forgedPayload}.${signature}`, "secret"), null);
});

test("rejects malformed tokens and missing secrets", async () => {
  assert.equal(await verifySession("not-a-token", "secret"), null);
  assert.equal(await verifySession("a.b.c", ""), null);
  assert.equal(await verifySession(null, "secret"), null);
});

test("cookie helpers set the expected flags and can be read back", () => {
  const header = sessionCookieHeader("abc123");
  assert.match(header, /^atlas_session=abc123;/u);
  assert.match(header, /HttpOnly/u);
  assert.match(header, /Secure/u);
  assert.match(header, /SameSite=Lax/u);

  const cleared = clearSessionCookieHeader();
  assert.match(cleared, /^atlas_session=; Max-Age=0/u);

  const request = new Request("http://localhost/", { headers: { cookie: "other=1; atlas_session=abc123; another=2" } });
  assert.equal(readSessionCookie(request), "abc123");
  assert.equal(readSessionCookie(new Request("http://localhost/")), null);
});
