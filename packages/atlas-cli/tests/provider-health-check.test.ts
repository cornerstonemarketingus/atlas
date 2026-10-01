import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { checkProviderStatus } from "../src/infrastructure/provider-health-check.js";

describe("checkProviderStatus — cloud providers", () => {
  it("reports ready when the API key environment variable is set", async () => {
    const result = await checkProviderStatus({
      providerId: "anthropic",
      apiKeyEnvironmentVariable: "ANTHROPIC_API_KEY",
      environment: { ANTHROPIC_API_KEY: "sk-test" },
    });
    assert.equal(result.ready, true);
    assert.equal(result.providerId, "anthropic");
    assert.match(result.message, /is set/u);
  });

  it("reports not ready when the API key environment variable is unset", async () => {
    const result = await checkProviderStatus({
      providerId: "groq",
      apiKeyEnvironmentVariable: "GROQ_API_KEY",
      environment: {},
    });
    assert.equal(result.ready, false);
    assert.match(result.message, /is not set/u);
  });

  it("treats a blank API key value as unset", async () => {
    const result = await checkProviderStatus({
      providerId: "groq",
      apiKeyEnvironmentVariable: "GROQ_API_KEY",
      environment: { GROQ_API_KEY: "   " },
    });
    assert.equal(result.ready, false);
  });

  it("never makes a network call for a cloud provider", async () => {
    let called = false;
    const result = await checkProviderStatus({
      providerId: "anthropic",
      apiKeyEnvironmentVariable: "ANTHROPIC_API_KEY",
      environment: { ANTHROPIC_API_KEY: "sk-test" },
      fetchImplementation: (async () => {
        called = true;
        throw new Error("should not be called");
      }) as typeof fetch,
    });
    assert.equal(called, false);
    assert.equal(result.ready, true);
  });
});

describe("checkProviderStatus — local provider", () => {
  it("reports ready and the model count when the server answers", async () => {
    const result = await checkProviderStatus({
      providerId: "local",
      apiKeyEnvironmentVariable: "",
      environment: {},
      endpoint: new URL("http://127.0.0.1:11434/v1"),
      fetchImplementation: (async (input: string | URL) => {
        assert.equal(String(input), "http://127.0.0.1:11434/v1/models");
        return new Response(JSON.stringify({ data: [{ id: "llama3.1" }, { id: "qwen2.5" }] }), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(result.ready, true);
    assert.equal(result.endpoint, "http://127.0.0.1:11434/v1/models");
    assert.match(result.message, /2 models available/u);
    assert.equal(typeof result.latencyMs, "number");
  });

  it("reports ready without a model count when the response body is not the expected shape", async () => {
    const result = await checkProviderStatus({
      providerId: "local",
      apiKeyEnvironmentVariable: "",
      environment: {},
      endpoint: new URL("http://127.0.0.1:11434/v1"),
      fetchImplementation: (async () => new Response("not json", { status: 200 })) as typeof fetch,
    });
    assert.equal(result.ready, true);
    assert.match(result.message, /Server reachable at/u);
  });

  it("reports not ready when the server responds with a non-ok status", async () => {
    const result = await checkProviderStatus({
      providerId: "local",
      apiKeyEnvironmentVariable: "",
      environment: {},
      endpoint: new URL("http://127.0.0.1:11434/v1"),
      fetchImplementation: (async () => new Response("", { status: 503 })) as typeof fetch,
    });
    assert.equal(result.ready, false);
    assert.match(result.message, /HTTP 503/u);
  });

  it("reports not ready when the server is unreachable", async () => {
    const result = await checkProviderStatus({
      providerId: "local",
      apiKeyEnvironmentVariable: "",
      environment: {},
      endpoint: new URL("http://127.0.0.1:11434/v1"),
      fetchImplementation: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    assert.equal(result.ready, false);
    assert.match(result.message, /Not reachable/u);
    assert.match(result.message, /ECONNREFUSED/u);
  });

  it("reports not ready when no endpoint is given", async () => {
    const result = await checkProviderStatus({
      providerId: "local",
      apiKeyEnvironmentVariable: "",
      environment: {},
    });
    assert.equal(result.ready, false);
    assert.match(result.message, /No endpoint/u);
  });

  it("strips a trailing slash before appending /models", async () => {
    const result = await checkProviderStatus({
      providerId: "local",
      apiKeyEnvironmentVariable: "",
      environment: {},
      endpoint: new URL("http://127.0.0.1:11434/v1/"),
      fetchImplementation: (async (input: string | URL) => {
        assert.equal(String(input), "http://127.0.0.1:11434/v1/models");
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(result.ready, true);
  });
});
