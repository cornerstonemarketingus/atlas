import assert from "node:assert/strict";
import test from "node:test";

import { SecretRedactionError, summarizeRedaction } from "../src/domain/secret-redaction.js";
import { PatternSecretRedactor } from "../src/infrastructure/pattern-secret-redactor.js";
import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJklmnopqr";
const PLACEHOLDER = /^\[redacted:[a-z-]+:[0-9a-f]{8}\]$/;

function redactor(): PatternSecretRedactor {
  return new PatternSecretRedactor();
}

test("replaces a detected secret with a categorized placeholder", async () => {
  const result = await redactor().redact(`token = "${GITHUB_TOKEN}"`);

  assert.equal(result.redactionCount, 1);
  assert.equal(result.text.includes(GITHUB_TOKEN), false);
  const placeholder = /\[redacted:github-token:[0-9a-f]{8}\]/.exec(result.text);
  assert.notEqual(placeholder, null);
  assert.deepEqual(result.findings, [{ category: "github-token", count: 1 }]);
});

test("emits the same placeholder for the same secret in different places", async () => {
  const result = await redactor().redact(`a=${GITHUB_TOKEN}\nb=${GITHUB_TOKEN}\n`);

  const placeholders = [...result.text.matchAll(/\[redacted:github-token:([0-9a-f]{8})\]/g)];
  assert.equal(placeholders.length, 2);
  assert.equal(placeholders[0]?.[1], placeholders[1]?.[1]);
  assert.equal(result.redactionCount, 2);
});

test("emits different placeholders for different secrets", async () => {
  const other = "ghp_zzzzzzzzzzzzzzzzzzzzZZZZZZZZZZZZZZZZZZZZ";
  const result = await redactor().redact(`a=${GITHUB_TOKEN}\nb=${other}\n`);

  const placeholders = [...result.text.matchAll(/\[redacted:github-token:([0-9a-f]{8})\]/g)];
  assert.equal(placeholders.length, 2);
  assert.notEqual(placeholders[0]?.[1], placeholders[1]?.[1]);
});

test("never embeds a prefix of the secret itself in the placeholder", async () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const result = await redactor().redact(secret);

  const placeholder = result.text.trim();
  assert.match(placeholder, PLACEHOLDER);
  for (let length = 4; length <= secret.length; length += 1) {
    assert.equal(placeholder.includes(secret.slice(0, length)), false);
  }
});

test("preserves surrounding content and only removes the secret", async () => {
  const result = await redactor().redact(`GITHUB_TOKEN=${GITHUB_TOKEN}\nPORT=8080\n`);

  assert.match(result.text, /^GITHUB_TOKEN=\[redacted:github-token:[0-9a-f]{8}\]\nPORT=8080\n$/);
});

test("detects aws access key ids and labelled aws secret access keys", async () => {
  const text = [
    "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  ].join("\n");

  const result = await redactor().redact(text);

  assert.equal(result.text.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.equal(result.text.includes("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"), false);
  assert.match(result.text, /\[redacted:aws-access-key-id:[0-9a-f]{8}\]/);
  assert.match(result.text, /\[redacted:aws-secret-access-key:[0-9a-f]{8}\]/);
});

test("detects every supported github token prefix", async () => {
  const tokens = [
    "ghp_0123456789abcdefghijABCDEFGHIJklmnop",
    "gho_0123456789abcdefghijABCDEFGHIJklmnop",
    "ghu_0123456789abcdefghijABCDEFGHIJklmnop",
    "ghs_0123456789abcdefghijABCDEFGHIJklmnop",
    "ghr_0123456789abcdefghijABCDEFGHIJklmnop",
    "github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789",
  ];

  const result = await redactor().redact(tokens.join("\n"));

  for (const token of tokens) assert.equal(result.text.includes(token), false);
  assert.deepEqual(result.findings, [{ category: "github-token", count: tokens.length }]);
});

test("distinguishes anthropic, openai, and groq key shapes", async () => {
  const text = [
    "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "sk-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    "gsk_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  ].join("\n");

  const result = await redactor().redact(text);

  assert.deepEqual(result.findings, [
    { category: "anthropic-api-key", count: 1 },
    { category: "groq-api-key", count: 1 },
    { category: "openai-api-key", count: 2 },
  ]);
});

test("detects stripe, slack, and google credentials", async () => {
  const text = [
    "sk_live_0123456789abcdefghij",
    "sk_test_0123456789abcdefghij",
    "rk_live_0123456789abcdefghij",
    "whsec_0123456789abcdefghijklmn",
    "xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx",
    "AIzaSyA0123456789abcdefghijklmnopqrstuv",
  ].join("\n");

  const result = await redactor().redact(text);

  assert.deepEqual(result.findings, [
    { category: "google-api-key", count: 1 },
    { category: "slack-token", count: 1 },
    { category: "stripe-key", count: 4 },
  ]);
});

test("redacts a private key body while keeping the pem armour readable", async () => {
  const text = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEA0123456789abcdefghijklmnopqrstuvwxyz",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

  const result = await redactor().redact(text);

  assert.equal(result.text.includes("MIIEowIBAAKCAQEA"), false);
  assert.match(result.text, /^-----BEGIN RSA PRIVATE KEY-----\[redacted:private-key:[0-9a-f]{8}\]-----END RSA PRIVATE KEY-----$/);
});

test("redacts an unlabelled private key block", async () => {
  const text = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

  const result = await redactor().redact(text);

  assert.deepEqual(result.findings, [{ category: "private-key", count: 1 }]);
});

test("redacts json web tokens", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

  const result = await redactor().redact(`Authorization: Bearer ${jwt}`);

  assert.equal(result.text.includes(jwt), false);
  assert.deepEqual(result.findings, [{ category: "jwt", count: 1 }]);
});

test("redacts generic env-style secret assignments", async () => {
  const text = [
    "DATABASE_PASSWORD=hunter2-correct-horse",
    "export SESSION_SECRET=s3cr3t-value-here",
    "api_key: 0123456789abcdefghij",
    "  - AUTH_TOKEN=abcdef123456",
  ].join("\n");

  const result = await redactor().redact(text);

  assert.equal(result.redactionCount, 4);
  assert.deepEqual(result.findings, [{ category: "generic-secret", count: 4 }]);
  assert.equal(result.text.includes("hunter2-correct-horse"), false);
  assert.equal(result.text.includes("s3cr3t-value-here"), false);
  assert.match(result.text, /^DATABASE_PASSWORD=\[redacted:generic-secret:[0-9a-f]{8}\]$/m);
});

test("redacts only the password inside a connection string", async () => {
  const result = await redactor().redact("DATABASE_URL=postgres://atlas:s3cr3tpass@db.example.com:5432/atlas\n");

  assert.equal(result.text.includes("s3cr3tpass"), false);
  assert.match(
    result.text,
    /^DATABASE_URL=postgres:\/\/atlas:\[redacted:url-credentials:[0-9a-f]{8}\]@db\.example\.com:5432\/atlas\n$/,
  );
});

test("does not redact urls without inline credentials", async () => {
  const text = "https://registry.npmjs.org/typescript\nhttp://localhost:3000/api\n";

  const result = await redactor().redact(text);

  assert.equal(result.redactionCount, 0);
  assert.equal(result.text, text);
});

test("does not redact git shas, uuids, or lockfile integrity hashes", async () => {
  const text = [
    "commit 9c1185a5c5e9fc54612808977ee8f548b2258d31",
    "id: 550e8400-e29b-41d4-a716-446655440000",
    '"integrity": "sha512-8mVEB8B4XuAvL1n+ZKvyOFRJ5wPzUEBcaS9nJgY2LhY7RRKzXPZ8/2Q6yqNPzKhrGZ+ITY7yWU2gWfOuVU5wLg=="',
    '"resolved": "https://registry.npmjs.org/typescript/-/typescript-5.7.2.tgz"',
  ].join("\n");

  const result = await redactor().redact(text);

  assert.equal(result.redactionCount, 0);
  assert.equal(result.text, text);
});

test("does not redact ordinary prose that mentions a token or password", async () => {
  const text = [
    "The token: value pairs are documented below.",
    "Ask the user for their password: it is never stored.",
    "Rotate the api key quarterly.",
  ].join("\n");

  const result = await redactor().redact(text);

  assert.equal(result.redactionCount, 0);
});

test("does not redact variable references or documentation placeholders", async () => {
  const text = [
    "GITHUB_TOKEN=${GITHUB_TOKEN}",
    "API_KEY=<your-api-key>",
    "SLACK_TOKEN={{ secrets.SLACK_TOKEN }}",
    "PASSWORD=xxxxxxxx",
    "CLONE_URL=https://x-access-token:${GITHUB_TOKEN}@github.com/atlas/atlas.git",
  ].join("\n");

  const result = await redactor().redact(text);

  assert.equal(result.redactionCount, 0);
  assert.equal(result.text, text);
});

test("does not redact ordinary source that merely names tokens or keys", async () => {
  const text = [
    "  readonly token: string;",
    "  inputTokens: usage.inputTokens,",
    "  contextWindowTokens: 128_000,",
    "  max_new_tokens=64",
    "  token = randomBytes(TOKEN_BYTES).toString(\"base64url\");",
    "  self.token_embedding_table = nn.Embedding(vocab, embed)",
  ].join("\n");

  const result = await redactor().redact(text);

  assert.equal(result.redactionCount, 0);
  assert.equal(result.text, text);
});

test("does not redact short or empty assignment values", async () => {
  const result = await redactor().redact("TOKEN=\nAPI_KEY=true\nPASSWORD=");

  assert.equal(result.redactionCount, 0);
});

test("reports a clean scan without claiming a redaction", async () => {
  const result = await redactor().redact("export const answer = 42;\n");

  assert.equal(result.redactionCount, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.findings, []);
  assert.equal(result.text, "export const answer = 42;\n");
});

test("drops the unscanned tail instead of passing it through unredacted", async () => {
  const filler = "safe line of source\n".repeat(20);
  const bounded = new PatternSecretRedactor({ maxInputCharacters: filler.length });

  const result = await bounded.redact(`${filler}TRAILING_SECRET=${GITHUB_TOKEN}\n`);

  assert.equal(result.truncated, true);
  assert.equal(result.text.includes(GITHUB_TOKEN), false);
  assert.match(result.text, /\[redacted:unscanned:\d+-characters\]$/);
  assert.ok(result.scannedCharacters <= filler.length);
});

test("never leaves a partial token behind when the scan bound splits a line", async () => {
  const bounded = new PatternSecretRedactor({ maxInputCharacters: 20 });

  const result = await bounded.redact(`AKIAIOSFODNN7EXAMPLE and more text`);

  assert.equal(result.text.includes("AKIA"), false);
  assert.equal(result.truncated, true);
});

test("counts only the scanned characters when the input is bounded", async () => {
  const bounded = new PatternSecretRedactor({ maxInputCharacters: 10 });

  const result = await bounded.redact("0123456789\nabcdefghij\n");

  assert.equal(result.scannedCharacters, 0);
  assert.equal(result.truncated, true);
});

test("rejects invalid construction limits", () => {
  assert.throws(() => new PatternSecretRedactor({ maxInputCharacters: 0 }), hasCode("INVALID_LIMIT"));
  assert.throws(() => new PatternSecretRedactor({ fingerprintLength: 2 }), hasCode("INVALID_LIMIT"));
  assert.throws(() => new PatternSecretRedactor({ fingerprintLength: 64 }), hasCode("INVALID_LIMIT"));
});

test("rejects non-string input rather than coercing it", async () => {
  await assert.rejects(
    redactor().redact(undefined as unknown as string),
    hasCode("INVALID_INPUT"),
  );
});

test("fails closed when the injected digest throws", async () => {
  const failing = new PatternSecretRedactor({
    digest: async () => { throw new Error("no crypto here"); },
  });

  await assert.rejects(failing.redact(`TOKEN=${GITHUB_TOKEN}`), hasCode("DIGEST_FAILED"));
});

test("does not call the digest when nothing was detected", async () => {
  let calls = 0;
  const counting = new PatternSecretRedactor({
    digest: async (data) => { calls += 1; return crypto.subtle.digest("SHA-256", data); },
  });

  await counting.redact("const port = 8080;\n");

  assert.equal(calls, 0);
});

test("digests each distinct secret once", async () => {
  let calls = 0;
  const counting = new PatternSecretRedactor({
    digest: async (data) => { calls += 1; return crypto.subtle.digest("SHA-256", data); },
  });

  await counting.redact(`a=${GITHUB_TOKEN}\nb=${GITHUB_TOKEN}\nc=${GITHUB_TOKEN}\n`);

  assert.equal(calls, 1);
});

test("honours a configured fingerprint length", async () => {
  const wide = new PatternSecretRedactor({ fingerprintLength: 16 });

  const result = await wide.redact(GITHUB_TOKEN);

  assert.match(result.text.trim(), /^\[redacted:github-token:[0-9a-f]{16}\]$/);
});

test("summarizes a redaction without carrying the redacted text", async () => {
  const result = await redactor().redact(`TOKEN=${GITHUB_TOKEN}`);

  const summary = summarizeRedaction(result);

  assert.equal(Object.hasOwn(summary, "text"), false);
  assert.equal(summary.redactionCount, 1);
  assert.equal(JSON.stringify(summary).includes(GITHUB_TOKEN), false);
});

test("keeps tool output untouched when no redactor is configured", async () => {
  const registry = new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: "allow", rules: [] },
  });
  registerSecretLeakingTool(registry);

  const result = await registry.execute(request());

  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.status === "completed" ? result.output : null,
    { content: `GITHUB_TOKEN=${GITHUB_TOKEN}` },
  );
  assert.equal(result.status === "completed" ? result.redaction : "missing", undefined);
});

test("redacts tool output before it is returned to the agent", async () => {
  const registry = new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: "allow", rules: [] },
    redactor: redactor(),
  });
  registerSecretLeakingTool(registry);

  const result = await registry.execute(request());

  assert.equal(result.status, "completed");
  const output = result.status === "completed" ? result.output : null;
  assert.equal(JSON.stringify(output).includes(GITHUB_TOKEN), false);
  assert.match(
    JSON.stringify(output),
    /GITHUB_TOKEN=\[redacted:github-token:[0-9a-f]{8}\]/,
  );
});

test("reports what the registry redacted so callers can audit it", async () => {
  const registry = new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: "allow", rules: [] },
    redactor: redactor(),
  });
  registerSecretLeakingTool(registry);

  const result = await registry.execute(request());

  assert.equal(result.status, "completed");
  const redaction = result.status === "completed" ? result.redaction : undefined;
  assert.deepEqual(redaction?.findings, [{ category: "github-token", count: 1 }]);
  assert.equal(redaction?.redactionCount, 1);
});

test("preserves the shape of clean tool output through redaction", async () => {
  const registry = new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: "allow", rules: [] },
    redactor: redactor(),
  });
  registry.register({
    name: "read_source",
    description: "Read source text.",
    risk: "low",
    validateInput: (input) => input,
    execute: async () => ({ schemaVersion: 1, lines: ["const port = 8080;"], truncated: false }),
  });

  const result = await registry.execute(request());

  assert.deepEqual(
    result.status === "completed" ? result.output : null,
    { schemaVersion: 1, lines: ["const port = 8080;"], truncated: false },
  );
  assert.equal(result.status === "completed" ? result.redaction?.redactionCount : -1, 0);
});

test("propagates a redactor failure rather than returning unredacted output", async () => {
  const registry = new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: "allow", rules: [] },
    redactor: new PatternSecretRedactor({ digest: async () => { throw new Error("boom"); } }),
  });
  registerSecretLeakingTool(registry);

  await assert.rejects(registry.execute(request()), hasCode("DIGEST_FAILED"));
});

function registerSecretLeakingTool(registry: PolicyEnforcedReadOnlyToolRegistry): void {
  registry.register({
    name: "read_source",
    description: "Read source text.",
    risk: "low",
    validateInput: (input) => input,
    execute: async () => ({ content: `GITHUB_TOKEN=${GITHUB_TOKEN}` }),
  });
}

function request() {
  return {
    name: "read_source",
    input: null,
    scope: { kind: "repository", repositoryId: "atlas" } as const,
    context: { repositoryId: "atlas" },
  };
}

function hasCode(code: SecretRedactionError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof SecretRedactionError && error.code === code;
}

// The failure path and redaction were built independently — the tool-failure
// result predates the redactor — so this covers the seam between them:
// a thrown error's message reaches the model just like successful output does,
// and must be scrubbed the same way.
test("redacts a secret quoted in a tool's failure message", async () => {
  const registry = new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: "allow", rules: [] },
    redactor: redactor(),
  });
  registry.register({
    name: "read_source",
    description: "Read source text.",
    risk: "low",
    validateInput: (input) => input,
    execute: async () => {
      throw new Error(`could not parse config containing ${GITHUB_TOKEN}`);
    },
  });

  const result = await registry.execute(request());

  assert.equal(result.status, "failed");
  const message = result.status === "failed" ? result.message : "";
  assert.doesNotMatch(message, /ghp_/u);
  assert.match(message, /\[redacted:github-token:[0-9a-f]{8}\]/u);
  assert.match(message, /could not parse config containing/u);
});

test("leaves a tool failure message untouched when no redactor is configured", async () => {
  const registry = new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: "allow", rules: [] },
  });
  registry.register({
    name: "read_source",
    description: "Read source text.",
    risk: "low",
    validateInput: (input) => input,
    execute: async () => {
      throw new Error("plain failure");
    },
  });

  const result = await registry.execute(request());
  assert.equal(result.status === "failed" ? result.message : "", "plain failure");
});
