import assert from "node:assert/strict";
import test from "node:test";
import { GovernedModelProvider, estimateTokens } from "../src/infrastructure/governed-model-provider.js";
import { createHttpGovernor, governorFromEnvironment, quotaScopeFor } from "../src/infrastructure/inference-governor-client.js";
import type { GovernorGrant, GovernorOutcome, GovernorReservation, InferenceGovernor } from "../src/infrastructure/inference-governor-client.js";
import { RetryingModelProvider } from "../src/infrastructure/retrying-model-provider.js";
import { ModelProviderError, type ModelProvider, type ModelProviderMetadata, type ModelRequest, type ModelResponse } from "../src/model/model-provider.js";

const metadata: ModelProviderMetadata = {
  id: "groq", displayName: "Groq",
  models: [{ model: "m1", contextWindowTokens: 8000, maxOutputTokens: 1000, supportsTools: false, supportsJson: false, supportsStreaming: false }],
};
const ok: ModelResponse = { id: "r", providerId: "groq", model: "m1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
const request = { model: "m1", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }], maxOutputTokens: 100 };

function fakeGovernor(grants: Array<GovernorGrant | null>) {
  const log: string[] = [];
  const reservations: GovernorReservation[] = [];
  const outcomes: GovernorOutcome[] = [];
  const governor: InferenceGovernor = {
    reserve: async (reservation) => { log.push("reserve"); reservations.push(reservation); return grants.length > 1 ? grants.shift() ?? null : grants[0] ?? null; },
    release: async (outcome) => { log.push("release"); outcomes.push(outcome); },
    withdraw: async () => { log.push("withdraw"); },
  };
  return { governor, log, reservations, outcomes };
}
class Spy implements ModelProvider {
  public readonly metadata = metadata;
  public readonly requests: ModelRequest[] = [];
  readonly #responses: Array<ModelResponse | Error>;
  public constructor(responses: Array<ModelResponse | Error>) { this.#responses = [...responses]; }
  public async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const next = this.#responses.length > 1 ? this.#responses.shift() : this.#responses[0];
    if (next instanceof Error) throw next;
    return next ?? ok;
  }
}

test("a granted reservation sends the request once and reports success", async () => {
  const mock = new Spy([ok]);
  const { governor, log, reservations, outcomes } = fakeGovernor([{ granted: true, model: "m1" }]);
  await new GovernedModelProvider(mock, governor, { newRequestId: () => "req-1" }).complete(request);
  assert.deepEqual(log, ["reserve", "release"]);
  assert.equal(mock.requests.length, 1);
  assert.equal(reservations[0]?.requestId, "req-1");
  assert.deepEqual(reservations[0]?.models, ["m1"]);
  assert.ok((reservations[0]?.estimatedTokens ?? 0) >= 100, "the output allowance is part of the estimate");
  assert.deepEqual(outcomes[0], { requestId: "req-1", model: "m1", status: 200, kind: null });
});

test("it waits for capacity and sends nothing until the reservation is granted", async () => {
  const mock = new Spy([ok]);
  const { governor, log } = fakeGovernor([{ granted: false, waitMs: 2_000 }, { granted: false, waitMs: 1_500 }, { granted: true }]);
  const sleeps: number[] = [];
  await new GovernedModelProvider(mock, governor, { sleep: async (ms) => { sleeps.push(ms); assert.equal(mock.requests.length, 0, "still nothing sent while waiting"); } }).complete(request);
  assert.deepEqual(sleeps, [2_000, 1_500]);
  assert.deepEqual(log, ["reserve", "reserve", "reserve", "release"]);
});

test("a wait past the bound withdraws and raises a retryable rate limit carrying the wait; the provider is never called", async () => {
  const mock = new Spy([ok]);
  const { governor, log } = fakeGovernor([{ granted: false, waitMs: 45_000 }]);
  await assert.rejects(
    new GovernedModelProvider(mock, governor, { maximumWaitMs: 30_000, sleep: async () => { throw new Error("must not sleep"); } }).complete(request),
    (error: unknown) => error instanceof ModelProviderError && error.code === "rate-limit" && error.retryable && error.retryAfterMs === 45_000,
  );
  assert.deepEqual(log, ["reserve", "withdraw"]);
  assert.equal(mock.requests.length, 0);
});

test("a request larger than the model's whole allowance is refused as unavailable so a fallback route can take it", async () => {
  const mock = new Spy([ok]);
  const { governor, log } = fakeGovernor([{ granted: false, permanent: true, reason: "too_large" }]);
  await assert.rejects(
    new GovernedModelProvider(mock, governor).complete(request),
    (error: unknown) => error instanceof ModelProviderError && error.code === "model-unavailable" && !error.retryable,
  );
  assert.deepEqual(log, ["reserve", "withdraw"]);
  assert.equal(mock.requests.length, 0);
});

test("an unavailable governor never stops work: the request is sent and nothing is released", async () => {
  const mock = new Spy([ok]);
  const { governor, log } = fakeGovernor([null]);
  await new GovernedModelProvider(mock, governor).complete(request);
  assert.deepEqual(log, ["reserve"]);
  assert.equal(mock.requests.length, 1);
});

test("a provider rate limit is reported with its retry-after so everyone sharing the quota stops, and a long one is marked daily", async () => {
  for (const [retryAfterMs, daily] of [[7_000, false], [3_600_000, true]] as const) {
    const error = new ModelProviderError({ message: "429", code: "rate-limit", providerId: "groq", retryable: true, retryAfterMs });
    const { governor, outcomes } = fakeGovernor([{ granted: true }]);
    await assert.rejects(new GovernedModelProvider(new Spy([error]), governor).complete(request), (thrown: unknown) => thrown === error);
    assert.equal(outcomes[0]?.status, 429);
    assert.equal(outcomes[0]?.kind, "RATE_LIMIT");
    assert.equal(outcomes[0]?.retryAfterMs, retryAfterMs);
    assert.equal(outcomes[0]?.scope, daily ? "daily" : undefined);
  }
});

test("other failures release with their kind, and billing/auth kinds are not mistaken for rate limits", async () => {
  for (const [code, kind] of [["authentication", "AUTHENTICATION"], ["provider-failure", "SERVER_ERROR"], ["model-unavailable", "MODEL_NOT_FOUND"]] as const) {
    const { governor, outcomes } = fakeGovernor([{ granted: true }]);
    await assert.rejects(new GovernedModelProvider(new Spy([new ModelProviderError({ message: code, code, providerId: "groq", retryable: false })]), governor).complete(request));
    assert.equal(outcomes[0]?.kind, kind);
    assert.equal(outcomes[0]?.status, undefined);
  }
});

test("cancellation before the call never reserves; cancellation while waiting withdraws and never sends", async () => {
  const mock = new Spy([ok]);
  const before = fakeGovernor([{ granted: true }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new GovernedModelProvider(mock, before.governor).complete(request, { signal: controller.signal }), (e: unknown) => e instanceof ModelProviderError && e.code === "cancelled");
  assert.deepEqual(before.log, []);

  const during = fakeGovernor([{ granted: false, waitMs: 5_000 }]);
  await assert.rejects(
    new GovernedModelProvider(mock, during.governor, { sleep: async () => { throw new Error("aborted"); } }).complete(request),
    (e: unknown) => e instanceof ModelProviderError && e.code === "cancelled",
  );
  assert.deepEqual(during.log, ["reserve", "withdraw"]);
  assert.equal(mock.requests.length, 0);
});

test("inside the retrying layer every attempt reserves again, and a failed attempt does not leave its reservation held", async () => {
  const transient = new ModelProviderError({ message: "busy", code: "provider-failure", providerId: "groq", retryable: true });
  const mock = new Spy([transient, ok]);
  const { governor, log } = fakeGovernor([{ granted: true }]);
  const provider = new RetryingModelProvider(new GovernedModelProvider(mock, governor), { maximumAttempts: 3, sleep: async () => {} });
  await provider.complete(request);
  assert.deepEqual(log, ["reserve", "release", "reserve", "release"]);
});

test("the estimate grows with the prompt and defaults the output allowance", () => {
  const small = estimateTokens({ model: "m1", messages: [] });
  const large = estimateTokens({ model: "m1", messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(4_000) }] }] });
  assert.ok(small >= 4_096 && large - small >= 900);
});

test("the quota scope matches the Worker's: origin plus the first eight bytes of the key's SHA-256, never the key", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("secret-key")));
  const expected = `https://api.groq.com#${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  assert.equal(quotaScopeFor("https://api.groq.com/openai/v1", "secret-key"), expected);
  assert.equal(quotaScopeFor("https://api.groq.com", undefined), "https://api.groq.com");
  assert.doesNotMatch(expected, /secret-key/u);
});

test("the HTTP governor sends the token and scope, never the provider key, and degrades to 'unavailable' without throwing", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const warnings: string[] = [];
  const respond = (status: number, body: unknown) => (async (url: URL | string, init?: RequestInit) => { seen.push({ url: String(url), init: init ?? {} }); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  const scope = quotaScopeFor("https://api.groq.com", "provider-key");
  const governor = createHttpGovernor({ url: "https://atlas.example/api/inference/governor", token: "gov-token", scope, fetch: respond(200, { granted: true, model: "m1" }), warn: (m) => warnings.push(m) });
  assert.deepEqual(await governor.reserve({ requestId: "r1", models: ["m1"], estimatedTokens: 10, latencyClass: "TASK_CRITICAL", priority: 0 }), { granted: true, model: "m1" });
  const sent = seen[0]!;
  assert.equal((sent.init.headers as Record<string, string>)["authorization"], "Bearer gov-token");
  assert.equal(sent.init.redirect, "error");
  assert.deepEqual(JSON.parse(String(sent.init.body)).scope, scope);
  assert.doesNotMatch(String(sent.init.body), /provider-key/u);

  const down = createHttpGovernor({ url: "https://atlas.example/g", token: "t", scope, fetch: respond(503, { message: "x" }), warn: (m) => warnings.push(m) });
  assert.equal(await down.reserve({ requestId: "r2", models: ["m1"], estimatedTokens: 1, latencyClass: "TASK_CRITICAL", priority: 0 }), null);
  await down.release({ requestId: "r2", model: "m1", kind: null });
  const broken = createHttpGovernor({ url: "https://atlas.example/g", token: "t", scope, fetch: (async () => { throw new TypeError("network"); }) as typeof fetch, warn: (m) => warnings.push(m) });
  assert.equal(await broken.reserve({ requestId: "r3", models: ["m1"], estimatedTokens: 1, latencyClass: "TASK_CRITICAL", priority: 0 }), null);
  assert.equal(warnings.length, 2, "each client warns once, not per call");
  assert.doesNotMatch(warnings.join(" "), /gov-token|provider-key/u);
});

test("the governor URL must be https except loopback, and configuration needs both URL and token", () => {
  assert.throws(() => createHttpGovernor({ url: "http://atlas.example/g", token: "t", scope: "https://a.test" }), /https/u);
  assert.doesNotThrow(() => createHttpGovernor({ url: "http://127.0.0.1:8787/g", token: "t", scope: "https://a.test" }));
  const route = { providerId: "groq", apiKey: "k" };
  assert.equal(governorFromEnvironment({}, route), undefined);
  assert.equal(governorFromEnvironment({ ATLAS_GOVERNOR_URL: "https://a.test/g" }, route), undefined);
  assert.equal(governorFromEnvironment({ ATLAS_GOVERNOR_TOKEN: "t" }, route), undefined);
  assert.ok(governorFromEnvironment({ ATLAS_GOVERNOR_URL: "https://a.test/g", ATLAS_GOVERNOR_TOKEN: "t" }, route));
});
