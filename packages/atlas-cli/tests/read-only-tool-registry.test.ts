import assert from "node:assert/strict";
import test from "node:test";
import { ReadOnlyToolRegistryError } from "../src/domain/read-only-tool-registry.js";
import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";

function registry(decision: "allow" | "ask" | "deny"): PolicyEnforcedReadOnlyToolRegistry {
  return new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: decision, rules: [] },
  });
}

function registerEcho(target: PolicyEnforcedReadOnlyToolRegistry, calls: string[]): void {
  target.register({
    name: "read_source",
    description: "Read source text.",
    risk: "low",
    validateInput: (input) => {
      if (typeof input !== "string") throw new Error("Input must be a string.");
      return input;
    },
    execute: async (input) => {
      calls.push(input);
      return input.toUpperCase();
    },
  });
}

test("executes validated read-only tools only when policy allows", async () => {
  const calls: string[] = [];
  const target = registry("allow");
  registerEcho(target, calls);

  const result = await target.execute({
    name: "read_source",
    input: "atlas",
    scope: { kind: "repository", repositoryId: "atlas" },
    context: { repositoryId: "atlas" },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.status === "completed" ? result.output : null, "ATLAS");
  assert.deepEqual(calls, ["atlas"]);
});

test("does not invoke handlers when approval is required or policy denies", async () => {
  const calls: string[] = [];
  const ask = registry("ask");
  registerEcho(ask, calls);
  const request = {
    name: "read_source",
    input: "atlas",
    scope: { kind: "repository", repositoryId: "atlas" } as const,
    context: { repositoryId: "atlas" },
  };

  assert.equal((await ask.execute(request)).status, "approval-required");
  const deny = registry("deny");
  registerEcho(deny, calls);
  await assert.rejects(deny.execute(request), hasCode("POLICY_DENIED"));
  assert.deepEqual(calls, []);
});

test("rejects mismatched repository scopes before executing", async () => {
  const calls: string[] = [];
  const target = registry("allow");
  registerEcho(target, calls);

  await assert.rejects(target.execute({
    name: "read_source",
    input: "atlas",
    scope: { kind: "repository", repositoryId: "other" },
    context: { repositoryId: "atlas" },
  }), hasCode("SCOPE_MISMATCH"));
  assert.deepEqual(calls, []);
});

test("rejects duplicate and unknown tools", async () => {
  const target = registry("allow");
  registerEcho(target, []);
  assert.throws(() => registerEcho(target, []), hasCode("DUPLICATE_TOOL"));
  await assert.rejects(target.execute({
    name: "missing",
    input: null,
    scope: { kind: "global" },
    context: { repositoryId: "atlas" },
  }), hasCode("TOOL_NOT_FOUND"));
});

test("evaluates a tool's declared capability, not a hardcoded 'read'", async () => {
  const target = new PolicyEnforcedReadOnlyToolRegistry({
    policy: {
      defaultDecision: "allow",
      rules: [{ id: "deny-writes", capabilities: ["write"], scope: { kind: "global" }, decision: "deny" }],
    },
  });
  registerEcho(target, []);
  target.register({
    name: "propose_edit",
    description: "Write a file.",
    risk: "high",
    capability: "write",
    validateInput: (input) => input,
    execute: async () => "applied",
  });

  const readResult = await target.execute({
    name: "read_source",
    input: "atlas",
    scope: { kind: "global" },
    context: { repositoryId: "atlas" },
  });
  assert.equal(readResult.status, "completed");

  await assert.rejects(target.execute({
    name: "propose_edit",
    input: "atlas",
    scope: { kind: "global" },
    context: { repositoryId: "atlas" },
  }), hasCode("POLICY_DENIED"));
});

function hasCode(code: ReadOnlyToolRegistryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ReadOnlyToolRegistryError && error.code === code;
}
