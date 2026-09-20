import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createDeepLinkSigner, appleAppSiteAssociation, androidAssetLinks, DeepLinkError } from "../src/mobile/deep-links.mjs";
import { biometricDecision, BIOMETRIC_EXEMPT_CAPABILITIES, FRESHNESS_MS } from "../src/mobile/biometric-policy.mjs";
import { createPushRegistry, buildApprovalNotification, assertPayloadIsSafe, sendApprovalPush, PushError } from "../src/mobile/push.mjs";
import { Buffer } from "node:buffer";
import { nextSessionState, canActOnCachedApproval } from "../src/mobile/session-state.mjs";
import { buildCrashReport, redactDiagnostic, consentCopy } from "../src/mobile/crash-reporting.mjs";

const SECRET = "0123456789abcdef0123456789abcdef0123456789";

test("an approval link opens exactly one item, on one device, once", () => {
  const signer = createDeepLinkSigner({ secret: SECRET, universalHost: "atlas.example.invalid" });
  const id = randomUUID();
  const link = signer.create({ target: "approval", id, deviceId: "phone-1" });

  assert.match(link.appLink, /^atlas:\/\/approval\?/u);
  assert.match(link.universalLink, /^https:\/\/atlas\.example\.invalid\/open\/approval\?/u);

  for (const form of [link.appLink, link.universalLink]) {
    const verified = signer.verify(form, { deviceId: "phone-1" });
    assert.equal(verified.valid, true, "both link forms verify");
    assert.equal(verified.target, "approval");
    assert.equal(verified.id, id);
  }

  // A link issued for one phone cannot be used on another.
  assert.equal(signer.verify(link.appLink, { deviceId: "phone-2" }).valid, false);
  assert.match(signer.verify(link.appLink, { deviceId: "phone-2" }).reason, /different device/u);

  // Approval links are one-time.
  const spent = new Set([link.nonce]);
  assert.match(signer.verify(link.appLink, { deviceId: "phone-1", spentNonces: spent }).reason, /already been used/u);

  // And they expire.
  assert.match(signer.verify(link.appLink, { deviceId: "phone-1", now: link.expiresAtMs + 1 }).reason, /expired/u);
});

test("a tampered or forged link is refused", () => {
  const signer = createDeepLinkSigner({ secret: SECRET });
  const mine = randomUUID();
  const theirs = randomUUID();
  const link = signer.create({ target: "approval", id: mine, deviceId: "phone-1" });

  // Swapping the item is the attack that matters: approve *this* instead.
  const swapped = link.appLink.replace(mine, theirs);
  assert.equal(signer.verify(swapped, { deviceId: "phone-1" }).valid, false);

  for (const tampered of [
    link.appLink.replace(/&e=\d+/u, "&e=99999999999999"),
    link.appLink.replace("approval", "session"),
    link.appLink.replace(/&d=[^&]+/u, "&d=phone-2"),
    link.appLink.replace(/&s=[^&]+/u, "&s=forged"),
  ]) {
    assert.equal(signer.verify(tampered, { deviceId: "phone-1" }).valid, false, `must refuse: ${tampered}`);
  }

  // A link signed by a different Atlas does not verify here.
  const other = createDeepLinkSigner({ secret: "ffffffffffffffffffffffffffffffffffffffff" });
  assert.equal(signer.verify(other.create({ target: "approval", id: mine, deviceId: "phone-1" }).appLink, { deviceId: "phone-1" }).valid, false);

  assert.equal(signer.verify("not a link", { deviceId: "phone-1" }).valid, false);
  assert.equal(signer.verify("atlas://settings?id=x", { deviceId: "phone-1" }).valid, false);
  assert.throws(() => createDeepLinkSigner({ secret: "short" }), DeepLinkError);
  assert.throws(() => signer.create({ target: "approval", id: "not-a-uuid", deviceId: "p" }), /specific resource/u);
  assert.throws(() => signer.create({ target: "approval", id: randomUUID() }), /paired device/u);
});

test("universal-link association files name the app and only the open path", () => {
  const apple = appleAppSiteAssociation({ teamId: "ABCDE12345", bundleId: "com.example.atlas" });
  assert.deepEqual(apple.applinks.details[0].appID, "ABCDE12345.com.example.atlas");
  assert.deepEqual(apple.applinks.details[0].paths, ["/open/*"], "only deep-link paths are claimed");

  const android = androidAssetLinks({ packageName: "com.example.atlas", sha256CertificateFingerprints: ["AA:BB"] });
  assert.equal(android[0].target.package_name, "com.example.atlas");
  assert.deepEqual(android[0].relation, ["delegate_permission/common.handle_all_urls"]);
});

test("high-risk approvals require fresh biometric re-authentication", () => {
  const now = 1_000_000;

  const low = biometricDecision({ approval: { capability: "repository.read", risk: "low" }, now });
  assert.equal(low.required, false);
  for (const capability of BIOMETRIC_EXEMPT_CAPABILITIES) {
    assert.equal(biometricDecision({ approval: { capability }, now }).required, false, `${capability} only reads`);
  }

  // An allowlist, so a capability nobody thought about re-authenticates. The
  // previous blocklist missed the ones the registry actually issues approvals
  // under, so a passer-by could approve a git push or a repository delete.
  for (const capability of ["communications.send", "infrastructure.write", "browser.submit", "browser.upload", "computer.high_risk", "repository.execute", "repository.git", "repository.write", "code.write", "filesystem.write", "some.capability.added.next.year"]) {
    assert.equal(biometricDecision({ approval: { capability }, now }).required, true, `${capability} must re-authenticate`);
  }
  // And an approval Atlas cannot describe is never waved through.
  assert.equal(biometricDecision({ approval: undefined, now }).required, true);
  assert.equal(biometricDecision({ approval: {}, now }).required, true);
  assert.equal(biometricDecision({ approval: { capability: "repository.read", risk: "high" }, now }).required, true);
  assert.equal(biometricDecision({ approval: { capability: "anything", risk: "critical" }, now }).required, true);
  assert.equal(biometricDecision({ approval: { actionClass: "destructive" }, now }).required, true);

  // Freshness is bounded: one check cannot cover an afternoon.
  const fresh = biometricDecision({ approval: { capability: "communications.send" }, lastVerifiedAtMs: now - 5_000, now });
  assert.equal(fresh.satisfied, true);
  const stale = biometricDecision({ approval: { capability: "communications.send" }, lastVerifiedAtMs: now - FRESHNESS_MS - 1, now });
  assert.equal(stale.satisfied, false);

  // No silent downgrade when the hardware is missing.
  const noHardware = biometricDecision({ approval: { capability: "communications.send" }, biometricsAvailable: false, now });
  assert.equal(noHardware.satisfied, false);
  assert.equal(noHardware.fallback, "device-passcode");
  assert.match(noHardware.reason, /biometrics are unavailable/u);
});

test("a push payload carries a link and nothing an attacker could use", () => {
  const signer = createDeepLinkSigner({ secret: SECRET });
  const link = signer.create({ target: "approval", id: randomUUID(), deviceId: "phone-1" });
  const notification = buildApprovalNotification({ approval: { capability: "communications.send" }, link });

  assert.match(notification.body, /Communications send is waiting/u);
  assert.equal(notification.data.link, link.appLink);
  assert.equal(notification.visibility, "private");
  assert.equal(assertPayloadIsSafe(notification), true);

  // The guard is what stops a future change quietly widening the payload.
  assert.throws(() => assertPayloadIsSafe({ data: { token: "ghp_abcdefghijklmnop" } }), PushError);
  assert.throws(() => assertPayloadIsSafe({ data: { secret: "x" } }), /secret field/u);
  assert.throws(() => assertPayloadIsSafe({ data: { digest: "a".repeat(64) } }), /action digest/u);
  assert.throws(() => buildApprovalNotification({ approval: {}, link: {} }), /deep link/u);
});

test("push registrations are revocable and never list a raw token", async () => {
  const registry = createPushRegistry();
  registry.register({ deviceId: "phone-1", platform: "apns", token: "a".repeat(64) });
  registry.register({ deviceId: "phone-2", platform: "fcm", token: "b".repeat(64) });

  const listed = registry.list();
  assert.equal(listed.length, 2);
  assert.equal(JSON.stringify(listed).includes("a".repeat(64)), false, "the raw token is never serialized");
  assert.ok(listed[0].tokenDigest.length === 64);

  assert.throws(() => registry.register({ deviceId: "x", platform: "sms", token: "a".repeat(64) }), PushError);
  assert.throws(() => registry.register({ deviceId: "x", platform: "apns", token: "short" }), /push token is required/u);

  const signer = createDeepLinkSigner({ secret: SECRET });
  const link = signer.create({ target: "approval", id: randomUUID(), deviceId: "phone-1" });
  const notification = buildApprovalNotification({ approval: { capability: "browser.submit" }, link });

  const sent = [];
  const result = await sendApprovalPush({
    registry, deviceId: "phone-1", notification,
    transports: { apns: { send: async (payload) => { sent.push(payload); return { id: "receipt-1" }; } } },
  });
  assert.equal(result.sent, true);
  assert.equal(sent[0].token, "a".repeat(64));

  // A device with no transport configured is reported, not silently dropped.
  const noTransport = await sendApprovalPush({ registry, deviceId: "phone-2", notification, transports: {} });
  assert.equal(noTransport.sent, false);
  assert.match(noTransport.reason, /No fcm transport is configured/u);

  // A revoked token removes the registration, so a lost phone stops receiving.
  const revoked = await sendApprovalPush({
    registry, deviceId: "phone-1", notification,
    transports: { apns: { send: async () => { const error = new Error("gone"); error.code = "TOKEN_REVOKED"; throw error; } } },
  });
  assert.equal(revoked.sent, false);
  assert.equal(registry.for("phone-1"), null, "the ghost registration was removed");

  assert.equal((await sendApprovalPush({ registry, deviceId: "unknown", notification, transports: {} })).sent, false);
});

test("offline and expired states say what is true and refuse to approve", () => {
  assert.equal(nextSessionState({ current: "connecting", event: { type: "connected" } }).state, "ready");
  assert.equal(nextSessionState({ current: "ready", event: { type: "connected" }, expiresAtMs: 1, now: 2 }).state, "expired");

  const offline = nextSessionState({ current: "ready", event: { type: "network-lost" } });
  assert.equal(offline.state, "offline");
  assert.equal(offline.canApprove, false);
  assert.match(offline.detail, /may be out of date/u, "the operator is told the list is stale");

  // A revoked device stays revoked when the network drops; the softer story
  // must not overwrite the true one.
  assert.equal(nextSessionState({ current: "revoked", event: { type: "network-lost" } }).state, "revoked");
  assert.equal(nextSessionState({ current: "unpaired", event: { type: "network-lost" } }).state, "unpaired");

  assert.equal(nextSessionState({ current: "ready", event: { type: "unauthorized" } }).state, "expired");
  assert.equal(nextSessionState({ current: "offline", event: { type: "retry" } }).state, "connecting");
  assert.equal(nextSessionState({ current: "revoked", event: { type: "retry" } }).state, "revoked");
  assert.equal(nextSessionState({ current: "ready", event: { type: "revoked" } }).canApprove, false);

  // No approving from a cached list.
  assert.equal(canActOnCachedApproval({ sessionState: "offline", cachedAtMs: Date.now() }).allowed, false);
  assert.equal(canActOnCachedApproval({ sessionState: "ready", cachedAtMs: Date.now() }).allowed, true);
  const stale = canActOnCachedApproval({ sessionState: "ready", cachedAtMs: 0, now: 10 * 60_000 });
  assert.equal(stale.allowed, false);
  assert.match(stale.reason, /Refresh before deciding/u);
});

test("crash reports need consent and are redacted either way", () => {
  const error = new Error("Failed for alex@example.invalid with Bearer ghp_abcdefghijklmnopqrst");
  error.stack = "Error: boom\n  at /home/alex/atlas/src/main.mjs:10\n  card 4111 1111 1111 1111\n  host 192.168.1.50";

  const unasked = buildCrashReport({ consent: "unasked", error, appVersion: "1.0.0", platform: "ios" });
  assert.equal(unasked.send, false);
  assert.match(unasked.reason, /has not asked about diagnostics/u);
  // Even the locally kept copy is redacted.
  assert.equal(unasked.local.summary.includes("alex@example.invalid"), false);
  assert.equal(unasked.local.stack.includes("4111 1111 1111 1111"), false);

  assert.equal(buildCrashReport({ consent: "denied", error, appVersion: "1.0.0", platform: "ios" }).send, false);

  const granted = buildCrashReport({ consent: "granted", error, appVersion: "1.0.0", platform: "android" });
  assert.equal(granted.send, true);
  assert.equal(granted.report.summary.includes("ghp_abcdefghijklmnopqrst"), false);
  assert.match(granted.report.summary, /\[credential\]|\[redacted\]/u);
  assert.match(granted.report.stack, /\[home\]/u);
  assert.match(granted.report.stack, /\[ip\]/u);
  assert.equal("userId" in granted.report, false, "a crash report does not identify anyone");

  assert.equal(redactDiagnostic("plain text"), "plain text");
  assert.equal(consentCopy().defaultState, "unasked", "consent is off until it is given");
  assert.match(consentCopy().body, /never include your conversations/u);
});


test("a link cannot be verified by a device that is not paired yet", () => {
  const signer = createDeepLinkSigner({ secret: SECRET, universalHost: "atlas.example.invalid" });
  const link = signer.create({ target: "approval", id: randomUUID(), deviceId: "phone-1" });

  // `if (deviceId && ...)` skipped the binding check whenever the verifier had
  // no device id — which is the shell's state on every install-then-pair run,
  // because the credential is read once at startup. Anyone holding a forwarded
  // link could open it on their own phone.
  for (const missing of [undefined, null, ""]) {
    const result = signer.verify(link.appLink, { deviceId: missing });
    assert.equal(result.valid, false, `deviceId=${JSON.stringify(missing)} must not verify`);
    assert.match(result.reason, /not paired yet/u);
  }
  assert.equal(signer.verify(link.appLink).valid, false, "no options at all is also refused");
  assert.equal(signer.verify(link.appLink, { deviceId: "phone-1" }).valid, true);
});

test("a link must arrive on this Atlas's own scheme and host", () => {
  const signer = createDeepLinkSigner({ secret: SECRET, universalHost: "atlas.example.invalid" });
  const link = signer.create({ target: "approval", id: randomUUID(), deviceId: "phone-1" });
  const query = link.appLink.split("?")[1];

  // The signature is valid in all of these; the destination is not ours.
  assert.equal(signer.verify(`nonsense://approval?${query}`, { deviceId: "phone-1" }).valid, false);
  assert.equal(signer.verify(`https://evil.example/open/approval?${query}`, { deviceId: "phone-1" }).valid, false);
  assert.equal(signer.verify(`https://atlas.example.invalid/open/approval?${query}`, { deviceId: "phone-1" }).valid, true);
});

test("a push payload cannot carry a digest in any casing or encoding", () => {
  const digest = "a".repeat(64);
  assert.throws(() => assertPayloadIsSafe({ data: { d: digest } }), PushError);
  assert.throws(() => assertPayloadIsSafe({ data: { d: digest.toUpperCase() } }), PushError, "uppercase hex must be caught");
  assert.throws(() => assertPayloadIsSafe({ data: { d: "AbCdEf0123456789".repeat(4) } }), PushError, "mixed case must be caught");
  assert.throws(() => assertPayloadIsSafe({ data: { d: Buffer.alloc(32).toString("base64url") + "xxxxx" } }), PushError, "base64url must be caught");

  // A real notification still passes.
  const signer = createDeepLinkSigner({ secret: SECRET });
  const link = signer.create({ target: "approval", id: randomUUID(), deviceId: "phone-1" });
  assert.equal(assertPayloadIsSafe(buildApprovalNotification({ approval: { capability: "browser.submit" }, link })), true);
});

test("the push registry keeps no raw token in the record it stores", () => {
  const store = new Map();
  const registry = createPushRegistry({ store });
  registry.register({ deviceId: "phone-1", platform: "apns", token: "SUPER-SECRET-PUSH-TOKEN-0123456789" });

  // The docstring promised storage by digest and then kept the plaintext
  // beside it, so a leaked store handed out a fleet's worth of tokens.
  assert.equal(JSON.stringify([...store.values()]).includes("SUPER-SECRET-PUSH-TOKEN-0123456789"), false);
  assert.equal(JSON.stringify(registry.list()).includes("SUPER-SECRET"), false);
  // The transport can still reach it.
  assert.equal(registry.for("phone-1").token, "SUPER-SECRET-PUSH-TOKEN-0123456789");
  registry.unregister("phone-1");
  assert.equal(registry.for("phone-1"), null);
});

test("reconnecting does not clear a revoked device", () => {
  // Revoked is a fact about the account, not the transport. Reconnecting used
  // to show "Connected" and re-enable the approve buttons.
  for (const state of ["revoked", "unpaired"]) {
    const next = nextSessionState({ current: state, event: { type: "connected" } });
    assert.equal(next.state, state);
    assert.equal(next.canApprove, false);
  }
  assert.equal(nextSessionState({ current: "connecting", event: { type: "connected" } }).state, "ready");
});

test("a Windows home path is actually redacted from a crash report", () => {
  // The pattern was over-escaped: `\\\\` in a regex literal is two literal
  // backslashes, so every Windows crash report shipped the account name under
  // a consent dialog promising file paths were removed.
  const report = buildCrashReport({
    consent: "granted",
    error: Object.assign(new Error("boom"), { stack: "at C:\\Users\\alice.smith\\atlas\\runner.js:12" }),
    appVersion: "1.0.0",
    platform: "windows",
  });
  assert.equal(report.report.stack.includes("alice.smith"), false);
  assert.match(report.report.stack, /\[home\]/u);
  assert.match(redactDiagnostic("at /home/alice/atlas/x.js"), /\[home\]/u);
});
