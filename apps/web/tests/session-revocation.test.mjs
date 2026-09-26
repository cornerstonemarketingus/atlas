import assert from "node:assert/strict";
import test from "node:test";

import { checkRevocation, revokeSession, sessionPrincipal } from "../app/api/auth/revocation.mjs";
import { OWNER_SESSION_TTL_SECONDS, sessionCookieHeader, signSession, verifySession } from "../app/api/auth/session.mjs";
import { authenticatedAccount } from "../app/api/tasks/operator-auth.mjs";

function memoryStore() {
  const sids = new Set();
  const cutoffs = new Map();
  return {
    sids, cutoffs,
    async isSidRevoked(sid) { return sids.has(sid); },
    async revokedBefore(principal) { return cutoffs.get(principal) ?? null; },
    async revokeSid({ sid }) { sids.add(sid); },
    async revokeAll({ principal, before }) { cutoffs.set(principal, before); },
  };
}

const SECRET = "test-session-secret-0123456789abcdef";
const requestWith = (token) => new Request("https://atlas.test/api/account", { headers: { cookie: `atlas_session=${token}` } });

test("every session has its own id, and owner sessions are short-lived", async () => {
  const a = await verifySession(await signSession({ role: "operator", gh: "owner" }, SECRET), SECRET);
  const b = await verifySession(await signSession({ role: "operator", gh: "owner" }, SECRET), SECRET);
  assert.match(a.sid, /^[0-9a-f-]{36}$/u);
  assert.notEqual(a.sid, b.sid);
  const owner = await verifySession(await signSession({ role: "operator" }, SECRET, Date.now(), OWNER_SESSION_TTL_SECONDS), SECRET);
  assert.equal(owner.exp - owner.iat, 12 * 60 * 60);
  assert.match(sessionCookieHeader("t", OWNER_SESSION_TTL_SECONDS), /Max-Age=43200/u);
  assert.equal(sessionPrincipal({ gh: "alice" }), "github:alice");
  assert.equal(sessionPrincipal({ role: "operator" }), "operator");
});

test("a signed-out session stops authenticating, even if the token was copied (SEC-2)", async () => {
  const store = memoryStore();
  const environment = { ATLAS_SESSION_SECRET: SECRET };
  const token = await signSession({ uid: 7, gh: "alice" }, SECRET);
  const other = await signSession({ uid: 7, gh: "alice" }, SECRET);
  assert.equal((await authenticatedAccount(requestWith(token), environment, { revocationStore: store })).userId, "github:alice");
  await revokeSession(await verifySession(token, SECRET), store);
  assert.equal(await authenticatedAccount(requestWith(token), environment, { revocationStore: store }), null);
  assert.equal((await authenticatedAccount(requestWith(other), environment, { revocationStore: store })).userId, "github:alice", "other devices stay signed in");

  // Sign out everywhere: every session issued up to now is refused.
  await revokeSession(await verifySession(other, SECRET), store, { everywhere: true, now: Date.now() + 1000 });
  assert.equal(await authenticatedAccount(requestWith(other), environment, { revocationStore: store }), null);
});

test("revocation degrades safely before its migration, and fails closed on other errors", async () => {
  const environment = { ATLAS_SESSION_SECRET: SECRET };
  const token = await signSession({ uid: 1, gh: "bob" }, SECRET);
  const missing = { isSidRevoked: async () => { throw new Error("D1_ERROR: no such table: revoked_sessions"); }, revokedBefore: async () => null };
  assert.deepEqual(await checkRevocation(await verifySession(token, SECRET), missing), { revoked: false, degraded: true });
  assert.equal((await authenticatedAccount(requestWith(token), environment, { revocationStore: missing })).userId, "github:bob");
  const broken = { isSidRevoked: async () => { throw new Error("D1_ERROR: network"); }, revokedBefore: async () => null };
  assert.equal(await authenticatedAccount(requestWith(token), environment, { revocationStore: broken }), null);
  const failing = { revokeSid: async () => { throw new Error("no such table: revoked_sessions"); } };
  assert.deepEqual(await revokeSession(await verifySession(token, SECRET), failing), { revoked: false, degraded: true });
});
