import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateToolPolicy,
  type ToolPolicy,
} from "../src/domain/tool-policy.js";

test("uses the explicit default when no capability rule matches", () => {
  const policy: ToolPolicy = {
    defaultDecision: "deny",
    rules: [
      {
        id: "read-source",
        capabilities: ["read"],
        scope: { kind: "global" },
        decision: "allow",
      },
    ],
  };

  assert.deepEqual(
    evaluateToolPolicy(policy, {
      capability: "execute",
      risk: "high",
      scope: { kind: "repository", repositoryId: "atlas" },
    }),
    { decision: "deny", matchedRuleIds: [], usedDefault: true },
  );
});

test("deny takes precedence over ask and allow regardless of rule order", () => {
  const policy: ToolPolicy = {
    defaultDecision: "deny",
    rules: [
      {
        id: "allow-repository-write",
        capabilities: ["write"],
        scope: { kind: "repository", repositoryId: "atlas" },
        decision: "allow",
      },
      {
        id: "deny-secrets",
        capabilities: ["read", "write"],
        scope: { kind: "path", repositoryId: "atlas", path: ".env" },
        decision: "deny",
      },
      {
        id: "ask-for-write",
        capabilities: ["write"],
        scope: { kind: "global" },
        decision: "ask",
      },
    ],
  };

  assert.deepEqual(
    evaluateToolPolicy(policy, {
      capability: "write",
      risk: "high",
      scope: { kind: "path", repositoryId: "atlas", path: ".env" },
    }),
    {
      decision: "deny",
      matchedRuleIds: ["allow-repository-write", "deny-secrets", "ask-for-write"],
      usedDefault: false,
    },
  );
});

test("matches path descendants but not sibling paths or repositories", () => {
  const policy: ToolPolicy = {
    defaultDecision: "deny",
    rules: [
      {
        id: "allow-generated-read",
        capabilities: ["read"],
        scope: { kind: "path", repositoryId: "atlas", path: "src/generated" },
        decision: "allow",
      },
    ],
  };

  assert.equal(evaluateToolPolicy(policy, {
    capability: "read",
    risk: "low",
    scope: { kind: "path", repositoryId: "atlas", path: "src\\generated\\api.ts" },
  }).decision, "allow");
  assert.equal(evaluateToolPolicy(policy, {
    capability: "read",
    risk: "low",
    scope: { kind: "path", repositoryId: "atlas", path: "src/generator.ts" },
  }).decision, "deny");
  assert.equal(evaluateToolPolicy(policy, {
    capability: "read",
    risk: "low",
    scope: { kind: "path", repositoryId: "other", path: "src/generated/api.ts" },
  }).decision, "deny");
});

test("repository rules apply to its paths while path rules do not apply repository-wide", () => {
  const policy: ToolPolicy = {
    defaultDecision: "ask",
    rules: [
      {
        id: "repository-network-deny",
        capabilities: ["network"],
        scope: { kind: "repository", repositoryId: "atlas" },
        decision: "deny",
      },
      {
        id: "source-read",
        capabilities: ["read"],
        scope: { kind: "path", repositoryId: "atlas", path: "src" },
        decision: "allow",
      },
    ],
  };

  assert.equal(evaluateToolPolicy(policy, {
    capability: "network",
    risk: "high",
    scope: { kind: "path", repositoryId: "atlas", path: "src/index.ts" },
  }).decision, "deny");
  assert.equal(evaluateToolPolicy(policy, {
    capability: "read",
    risk: "low",
    scope: { kind: "repository", repositoryId: "atlas" },
  }).decision, "ask");
});

test("rejects ambiguous paths and duplicate rule IDs", () => {
  assert.throws(() => evaluateToolPolicy({ defaultDecision: "deny", rules: [] }, {
    capability: "read",
    risk: "low",
    scope: { kind: "path", repositoryId: "atlas", path: "../outside" },
  }), /repository-relative/u);

  const duplicatePolicy: ToolPolicy = {
    defaultDecision: "deny",
    rules: [
      { id: "same", capabilities: ["read"], scope: { kind: "global" }, decision: "allow" },
      { id: "same", capabilities: ["write"], scope: { kind: "global" }, decision: "deny" },
    ],
  };
  assert.throws(() => evaluateToolPolicy(duplicatePolicy, {
    capability: "read",
    risk: "low",
    scope: { kind: "global" },
  }), /Duplicate/u);
});

test("matches explicitly classified risk levels", () => {
  const policy: ToolPolicy = {
    defaultDecision: "deny",
    rules: [
      {
        id: "ask-high-risk-execution",
        capabilities: ["execute"],
        risks: ["high", "critical"],
        scope: { kind: "global" },
        decision: "ask",
      },
    ],
  };

  assert.equal(evaluateToolPolicy(policy, {
    capability: "execute",
    risk: "high",
    scope: { kind: "repository", repositoryId: "atlas" },
  }).decision, "ask");
  assert.equal(evaluateToolPolicy(policy, {
    capability: "execute",
    risk: "low",
    scope: { kind: "repository", repositoryId: "atlas" },
  }).decision, "deny");
});
