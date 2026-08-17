import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderConfigurationError,
  validateProviderConfigurations,
} from "../src/model/provider-configuration.js";

test("accepts local loopback and hosted credential-reference configurations", () => {
  const result = validateProviderConfigurations([
    { id: "local", kind: "local", endpoint: "http://127.0.0.1:11434/v1", enabled: true },
    {
      id: "hosted",
      kind: "hosted",
      endpoint: "https://models.example.test/v1",
      credential: { source: "environment", variable: "ATLAS_PROVIDER_KEY" },
      enabled: false,
    },
  ]);
  assert.equal(result.length, 2);
  assert.notEqual(result[0], result[1]);
});

test("rejects embedded secrets and non-loopback local endpoints", () => {
  assert.throws(() => validateProviderConfigurations([{
    id: "bad",
    kind: "hosted",
    endpoint: "https://user:secret@example.test",
    credential: { source: "managed", id: "credential" },
    enabled: true,
  }]), hasCode("INVALID_ENDPOINT"));
  assert.throws(() => validateProviderConfigurations([{
    id: "remote-local",
    kind: "local",
    endpoint: "http://192.0.2.1:11434",
    enabled: true,
  }]), hasCode("INVALID_ENDPOINT"));
});

test("requires references for hosted credentials without accepting raw values", () => {
  assert.throws(() => validateProviderConfigurations([{
    id: "hosted",
    kind: "hosted",
    endpoint: "https://example.test",
    enabled: true,
  }]), hasCode("CREDENTIAL_REQUIRED"));
});

function hasCode(code: ProviderConfigurationError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ProviderConfigurationError && error.code === code;
}
