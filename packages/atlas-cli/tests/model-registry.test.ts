import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelRegistry,
  ModelRegistryError,
} from "../src/model/model-registry.js";
import type {
  ModelCapabilities,
  ModelProvider,
} from "../src/model/model-provider.js";

function provider(id: string, models: readonly ModelCapabilities[]): ModelProvider {
  return {
    metadata: { id, displayName: id, models },
    complete: async () => { throw new Error("not used by registry tests"); },
  };
}

function model(
  name: string,
  overrides: Partial<Omit<ModelCapabilities, "model">> = {},
): ModelCapabilities {
  return {
    model: name,
    contextWindowTokens: 8_000,
    maxOutputTokens: 2_000,
    supportsTools: false,
    supportsJson: false,
    supportsStreaming: false,
    ...overrides,
  };
}

test("routes by capabilities and token limits", () => {
  const registry = new ModelRegistry([
    provider("basic", [model("small")]),
    provider("capable", [model("large", {
      contextWindowTokens: 32_000,
      maxOutputTokens: 8_000,
      supportsTools: true,
      supportsJson: true,
    })]),
  ]);

  const selected = registry.route({
    tools: true,
    json: true,
    minimumContextWindowTokens: 16_000,
    minimumOutputTokens: 4_000,
  });
  assert.equal(selected.provider.metadata.id, "capable");
  assert.equal(selected.capabilities.model, "large");
});

test("selection is deterministic and honors supported preferences", () => {
  const registry = new ModelRegistry([
    provider("zeta", [model("z-model", { supportsStreaming: true })]),
    provider("alpha", [model("a-model", { supportsStreaming: true }), model("preferred", { supportsStreaming: true })]),
  ]);

  assert.equal(registry.route({ streaming: true }).provider.metadata.id, "alpha");
  assert.equal(
    registry.route({ streaming: true, preferredProviderId: "zeta" }).provider.metadata.id,
    "zeta",
  );
  assert.equal(
    registry.route({ streaming: true, preferredModel: "preferred" }).capabilities.model,
    "preferred",
  );
});

test("falls back when a preference does not satisfy requirements", () => {
  const registry = new ModelRegistry([
    provider("alpha", [model("preferred")]),
    provider("beta", [model("tools", { supportsTools: true })]),
  ]);
  assert.equal(
    registry.route({ tools: true, preferredProviderId: "alpha" }).provider.metadata.id,
    "beta",
  );
});

test("rejects unsupported and invalid requirements", () => {
  const registry = new ModelRegistry([provider("basic", [model("small")])]);
  assert.throws(
    () => registry.route({ tools: true }),
    (error: unknown) => error instanceof ModelRegistryError && error.code === "unsupported-requirements",
  );
  assert.throws(
    () => registry.route({ minimumOutputTokens: -1 }),
    (error: unknown) => error instanceof ModelRegistryError && error.code === "invalid-requirements",
  );
});

test("rejects duplicate providers and duplicate models within a provider", () => {
  assert.throws(
    () => new ModelRegistry([provider("same", [model("one")]), provider("same", [model("two")])]),
    (error: unknown) => error instanceof ModelRegistryError && error.code === "duplicate-provider",
  );
  assert.throws(
    () => new ModelRegistry([provider("one", [model("same"), model("same")])]),
    (error: unknown) => error instanceof ModelRegistryError && error.code === "duplicate-model",
  );
});

test("requires a provider when a preferred model name is ambiguous", () => {
  const registry = new ModelRegistry([
    provider("one", [model("shared")]),
    provider("two", [model("shared")]),
  ]);
  assert.throws(
    () => registry.route({ preferredModel: "shared" }),
    (error: unknown) => error instanceof ModelRegistryError && error.code === "ambiguous-model-preference",
  );
  assert.equal(
    registry.route({ preferredProviderId: "two", preferredModel: "shared" }).provider.metadata.id,
    "two",
  );
});
