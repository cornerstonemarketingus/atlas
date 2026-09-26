import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  CODER_PROVIDER_IDS,
  inferCoderProviderId,
  isCoderProviderId,
  selectCoderProvider,
} from "../src/model/coder-provider-selection.js";

function expectOk(result: ReturnType<typeof selectCoderProvider>) {
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  return result.selection;
}

describe("inferCoderProviderId", () => {
  it("routes Claude model identifiers to Anthropic", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "anthropic/claude-sonnet-5"]) {
      assert.equal(inferCoderProviderId(model), "anthropic", model);
    }
  });

  it("routes everything else to Groq, which is what existing callers mean", () => {
    for (const model of ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct"]) {
      assert.equal(inferCoderProviderId(model), "groq", model);
    }
  });

  it("does not mistake an unrelated model whose name merely contains 'claude'", () => {
    // The anchor matters: a hypothetical "notclaude-1" is not an Anthropic model,
    // and silently routing it there would send content to the wrong vendor.
    assert.equal(inferCoderProviderId("notclaude-1"), "groq");
    assert.equal(inferCoderProviderId("meta/claudel-7b"), "groq");
  });

  it("tolerates surrounding whitespace and casing", () => {
    assert.equal(inferCoderProviderId("  Claude-Opus-5 "), "anthropic");
  });
});

describe("isCoderProviderId", () => {
  it("accepts exactly the advertised identifiers", () => {
    for (const id of CODER_PROVIDER_IDS) assert.equal(isCoderProviderId(id), true, id);
    assert.equal(isCoderProviderId("openai"), false);
    assert.equal(isCoderProviderId(""), false);
    assert.equal(isCoderProviderId("Anthropic"), false);
  });
});

describe("selectCoderProvider", () => {
  it("infers Anthropic from the model and defaults its key environment variable", () => {
    const selection = expectOk(selectCoderProvider({ model: "claude-sonnet-5", tokenBudget: 16_384 }));
    assert.equal(selection.profile.providerId, "anthropic");
    assert.equal(selection.apiKeyEnvironmentVariable, "ANTHROPIC_API_KEY");
    assert.equal(selection.inferred, true);
  });

  it("keeps the existing Groq defaults for a non-Claude model", () => {
    const selection = expectOk(selectCoderProvider({ model: "llama-3.3-70b-versatile", tokenBudget: 16_384 }));
    assert.equal(selection.profile.providerId, "groq");
    assert.equal(selection.apiKeyEnvironmentVariable, "GROQ_API_KEY");
    // The pre-existing Groq turn cap must not have changed: raising it
    // reintroduces the HTTP 413 that the cap exists to avoid.
    assert.equal(selection.maxOutputTokensPerTurn, 1_024);
    assert.equal(selection.profile.contextWindowTokens, 128_000);
  });

  it("lets an explicit --provider override the inference", () => {
    const selection = expectOk(selectCoderProvider({
      provider: "anthropic",
      model: "some-internal-alias",
      tokenBudget: 16_384,
    }));
    assert.equal(selection.profile.providerId, "anthropic");
    assert.equal(selection.inferred, false);
  });

  it("lets an explicit --api-key-env override the provider default", () => {
    const selection = expectOk(selectCoderProvider({
      model: "claude-opus-5",
      apiKeyEnvironmentVariable: "ATLAS_CLAUDE_KEY",
      tokenBudget: 16_384,
    }));
    assert.equal(selection.apiKeyEnvironmentVariable, "ATLAS_CLAUDE_KEY");
  });

  it("ignores a blank --api-key-env rather than looking up an empty variable name", () => {
    const selection = expectOk(selectCoderProvider({
      model: "claude-opus-5",
      apiKeyEnvironmentVariable: "   ",
      tokenBudget: 16_384,
    }));
    assert.equal(selection.apiKeyEnvironmentVariable, "ANTHROPIC_API_KEY");
  });

  it("never lets one turn exceed the whole session budget", () => {
    const selection = expectOk(selectCoderProvider({ model: "claude-opus-5", tokenBudget: 512 }));
    assert.equal(selection.maxOutputTokensPerTurn, 512);
  });

  it("gives Anthropic a larger per-turn cap than Groq, which is rate-limited differently", () => {
    const anthropic = expectOk(selectCoderProvider({ model: "claude-opus-5", tokenBudget: 1_000_000 }));
    const groq = expectOk(selectCoderProvider({ model: "llama-3.3-70b-versatile", tokenBudget: 1_000_000 }));
    assert.equal(anthropic.maxOutputTokensPerTurn, 8_192);
    assert.equal(groq.maxOutputTokensPerTurn, 1_024);
  });

  it("rejects an unknown provider by name instead of silently falling back", () => {
    const result = selectCoderProvider({ provider: "openai", model: "gpt-4", tokenBudget: 16_384 });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.message, /Unknown --provider 'openai'/u);
    assert.match(result.message, /anthropic, groq/u);
  });

  it("treats a blank --provider as absent so inference still applies", () => {
    const selection = expectOk(selectCoderProvider({ provider: "  ", model: "claude-opus-5", tokenBudget: 16_384 }));
    assert.equal(selection.profile.providerId, "anthropic");
    assert.equal(selection.inferred, true);
  });

  it("rejects a non-positive or non-integer token budget", () => {
    for (const tokenBudget of [0, -1, 1.5, Number.NaN]) {
      const result = selectCoderProvider({ model: "claude-opus-5", tokenBudget });
      assert.equal(result.ok, false, String(tokenBudget));
    }
  });

  it("lets an operator raise the per-turn output ceiling for a paid tier", () => {
    const groq = expectOk(selectCoderProvider({ model: "openai/gpt-oss-120b", tokenBudget: 200_000, outputTokensPerTurn: 8_192 }));
    assert.equal(groq.maxOutputTokensPerTurn, 8_192);
    // Still never more than the whole session budget.
    const small = expectOk(selectCoderProvider({ model: "openai/gpt-oss-120b", tokenBudget: 2_000, outputTokensPerTurn: 8_192 }));
    assert.equal(small.maxOutputTokensPerTurn, 2_000);
  });

  it("refuses a per-turn output ceiling outside its range", () => {
    for (const outputTokensPerTurn of [0, 255, 32_769, 1.5, Number.NaN]) {
      const result = selectCoderProvider({ model: "openai/gpt-oss-120b", tokenBudget: 200_000, outputTokensPerTurn });
      assert.equal(result.ok, false, String(outputTokensPerTurn));
    }
  });
});
