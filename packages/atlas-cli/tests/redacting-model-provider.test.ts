import assert from "node:assert/strict";
import test from "node:test";

import { RedactingModelProvider } from "../src/infrastructure/redacting-model-provider.js";
import { PatternSecretRedactor } from "../src/infrastructure/pattern-secret-redactor.js";
import type { SecretRedactionSummary } from "../src/domain/secret-redaction.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../src/model/model-provider.js";

// Shaped like a real credential so the pattern rules fire, but not a real one.
const SECRET = "ghp_0123456789abcdefghijABCDEFGHIJ0123";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

/** Records what the wrapped provider was actually handed. */
function capturingProvider(): { provider: ModelProvider; seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  const provider: ModelProvider = {
    metadata: { id: "test", displayName: "Test", models: [] },
    async complete(request: ModelRequest): Promise<ModelResponse> {
      seen.push(request);
      return {
        id: "r1",
        providerId: "test",
        model: request.model,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };
  return { provider, seen };
}

function wrap(options?: ConstructorParameters<typeof RedactingModelProvider>[2]) {
  const { provider, seen } = capturingProvider();
  return { seen, redacting: new RedactingModelProvider(provider, new PatternSecretRedactor(), options) };
}

function request(messages: ModelRequest["messages"]): ModelRequest {
  return { model: "m", messages };
}

test("scrubs the system prompt, the objective, and repository evidence", async () => {
  const { seen, redacting } = wrap();
  await redacting.complete(request([
    { role: "system", content: [{ type: "text", text: `system ${SECRET}` }] },
    { role: "user", content: [{ type: "text", text: `objective ${SECRET}` }] },
    { role: "user", content: [{ type: "json", value: { evidence: `file has ${AWS_KEY}` } }] },
  ]));

  const sent = JSON.stringify(seen[0]);
  assert.equal(sent.includes(SECRET), false, "system/user text still carried the token");
  assert.equal(sent.includes(AWS_KEY), false, "json evidence still carried the key");
  assert.match(sent, /\[redacted:github-token:/u);
  assert.match(sent, /\[redacted:aws-access-key-id:/u);
});

test("scrubs tool results, which is how command output reaches the model", async () => {
  // A failing test that prints a credential reaches the model as repair
  // feedback, not as tool output — so this is the path a tool-only defence
  // would have missed entirely.
  const { seen, redacting } = wrap();
  await redacting.complete(request([
    { role: "user", content: [{ type: "text", text: `Your change broke: expected "${SECRET}" to equal "x"` }] },
    { role: "tool", toolCallId: "t1", isError: true, content: [{ type: "text", text: `stderr: ${SECRET}` }] },
  ]));

  assert.equal(JSON.stringify(seen[0]).includes(SECRET), false);
});

test("scrubs assistant text but NEVER assistant tool-call arguments", async () => {
  // The asymmetry is the whole point. A placeholder substituted into a tool
  // call's arguments would be written into the customer's repository verbatim,
  // or read back on a later turn and "restored" over the real content — data
  // corruption, not leak prevention. Repository content is already redacted by
  // the tool registry before the model can copy it, so nothing is lost.
  const { seen, redacting } = wrap();
  await redacting.complete(request([
    {
      role: "assistant",
      content: [
        { type: "text", text: `I will write ${SECRET}` },
        { type: "tool-call", id: "c1", name: "repository.propose_file_edit", arguments: { path: "fixture.ts", content: `const key = "${AWS_KEY}";` } },
      ],
    },
  ]));

  const sent = seen[0]!;
  const message = sent.messages[0]!;
  assert.equal(message.role, "assistant");
  if (message.role !== "assistant") throw new Error("unreachable");

  const text = message.content[0]!;
  assert.equal(text.type, "text");
  if (text.type !== "text") throw new Error("unreachable");
  assert.equal(text.text.includes(SECRET), false, "assistant prose should be scrubbed");

  const call = message.content[1]!;
  assert.equal(call.type, "tool-call");
  if (call.type !== "tool-call") throw new Error("unreachable");
  assert.equal(call.arguments['content'], `const key = "${AWS_KEY}";`, "tool-call arguments must pass through byte-for-byte");
});

test("returns the provider's response untouched", async () => {
  // The response is the model's own output and its tool calls go straight to
  // the editor; rewriting it here would corrupt writes for no security gain.
  const { redacting } = wrap();
  const response = await redacting.complete(request([{ role: "user", content: [{ type: "text", text: "hi" }] }]));
  assert.equal(response.message.content[0]?.type, "text");
  assert.equal(response.finishReason, "stop");
});

test("scrubs nested json values, array elements, and object keys", async () => {
  const { seen, redacting } = wrap();
  await redacting.complete(request([
    { role: "tool", toolCallId: "t1", isError: false, content: [{ type: "json", value: {
      files: [{ path: "a.env", lines: [`TOKEN=${SECRET}`] }],
      // A credential can be a key as well as a value in a parsed config.
      [SECRET]: "used-as-a-key",
      nested: { deep: { deeper: AWS_KEY } },
    } }] },
  ]));

  const sent = JSON.stringify(seen[0]);
  assert.equal(sent.includes(SECRET), false);
  assert.equal(sent.includes(AWS_KEY), false);
});

test("leaves ordinary content, structure, and non-string json byte-identical", async () => {
  // Over-redaction is its own failure: scrubbing git SHAs or lockfile hashes
  // would destroy the model's ability to reason about the repository.
  const { seen, redacting } = wrap();
  const value = { sha: "e81a9327c1f4b8a0d6e5c3b2a1908f7e6d5c4b3a", count: 7, ok: true, nothing: null, list: [1, 2, 3] };
  const original = request([
    { role: "system", content: [{ type: "text", text: "You are Atlas." }] },
    { role: "user", content: [{ type: "json", value }] },
  ]);
  await redacting.complete(original);

  assert.deepEqual(seen[0]?.messages, original.messages);
});

test("preserves request fields other than messages", async () => {
  const { seen, redacting } = wrap();
  await redacting.complete({
    model: "claude-opus-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxOutputTokens: 1234,
    temperature: 0.5,
    responseFormat: "json",
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
  });

  const sent = seen[0]!;
  assert.equal(sent.model, "claude-opus-5");
  assert.equal(sent.maxOutputTokens, 1234);
  assert.equal(sent.temperature, 0.5);
  assert.equal(sent.responseFormat, "json");
  assert.equal(sent.tools?.length, 1);
});

test("reports a measured summary, not an inferred one", async () => {
  const summaries: SecretRedactionSummary[] = [];
  const { redacting } = wrap({ onRedaction: (summary) => summaries.push(summary) });
  await redacting.complete(request([
    { role: "user", content: [{ type: "text", text: `${SECRET} and ${AWS_KEY}` }] },
  ]));

  assert.equal(summaries.length, 1);
  const summary = summaries[0]!;
  assert.equal(summary.redactionCount, 2);
  assert.ok(summary.scannedCharacters > 0, "scannedCharacters must be real, not zero-filled");
  assert.deepEqual(
    summary.findings.map((finding) => finding.category),
    ["aws-access-key-id", "github-token"],
    "findings must be populated and sorted",
  );
});

test("does not report a summary when there was nothing to redact", async () => {
  const summaries: SecretRedactionSummary[] = [];
  const { redacting } = wrap({ onRedaction: (summary) => summaries.push(summary) });
  await redacting.complete(request([{ role: "user", content: [{ type: "text", text: "nothing here" }] }]));
  assert.deepEqual(summaries, []);
});

test("counts a repeated secret every turn it would have left the process", async () => {
  // The cache exists to avoid re-scanning, not to make a replayed credential
  // vanish from the tally: the same transcript resent on ten turns is ten
  // separate occasions the secret was about to reach a third party.
  const summaries: SecretRedactionSummary[] = [];
  const { redacting } = wrap({ onRedaction: (summary) => summaries.push(summary) });
  const messages = request([{ role: "user", content: [{ type: "text", text: `token ${SECRET}` }] }]);

  await redacting.complete(messages);
  await redacting.complete(messages);

  assert.deepEqual(summaries.map((summary) => summary.redactionCount), [1, 1]);
  assert.equal(redacting.redactionCount, 1, "the underlying scan should have run only once");
});

test("gives the same secret the same placeholder across turns", async () => {
  const { seen, redacting } = wrap();
  await redacting.complete(request([{ role: "user", content: [{ type: "text", text: `a ${SECRET}` }] }]));
  await redacting.complete(request([{ role: "user", content: [{ type: "text", text: `b ${SECRET}` }] }]));

  const placeholder = /\[redacted:github-token:[0-9a-f]+\]/u;
  const first = JSON.stringify(seen[0]).match(placeholder)?.[0];
  const second = JSON.stringify(seen[1]).match(placeholder)?.[0];
  assert.ok(first, "expected a placeholder on the first turn");
  // Stable placeholders are what let the model tell that two files hold the
  // same value without being able to recover it.
  assert.equal(second, first);
});

test("keeps redacting correctly once the cache has evicted", async () => {
  const { seen, redacting } = wrap({ maxCacheEntries: 1 });
  await redacting.complete(request([{ role: "user", content: [{ type: "text", text: `one ${SECRET}` }] }]));
  await redacting.complete(request([{ role: "user", content: [{ type: "text", text: `two ${AWS_KEY}` }] }]));
  await redacting.complete(request([{ role: "user", content: [{ type: "text", text: `one ${SECRET}` }] }]));

  assert.equal(JSON.stringify(seen[2]).includes(SECRET), false);
});

test("rejects a nonsensical cache bound instead of silently disabling the cache", () => {
  const { provider } = capturingProvider();
  for (const maxCacheEntries of [0, -1, 1.5]) {
    assert.throws(
      () => new RedactingModelProvider(provider, new PatternSecretRedactor(), { maxCacheEntries }),
      RangeError,
    );
  }
});

test("fails closed when the redactor throws, rather than forwarding raw text", async () => {
  // If redaction cannot be performed, the request must not go out. Falling back
  // to the original text would turn an internal fault into a silent disclosure.
  const { provider, seen } = capturingProvider();
  const redacting = new RedactingModelProvider(provider, {
    redact: () => Promise.reject(new Error("digest unavailable")),
  });

  await assert.rejects(
    redacting.complete(request([{ role: "user", content: [{ type: "text", text: SECRET }] }])),
    /digest unavailable/u,
  );
  assert.deepEqual(seen, [], "no request should have reached the provider");
});

test("exposes the wrapped provider's metadata unchanged", () => {
  const { redacting } = wrap();
  assert.equal(redacting.metadata.id, "test");
});
