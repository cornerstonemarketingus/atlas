import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli.js";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_MAX_OUTPUT_TOKENS,
  resolveCoderEndpoint,
  resolveSelfHostedLimits,
} from "../src/model/coder-endpoint.js";

function endpointFor(value: string | undefined): string | undefined {
  const result = resolveCoderEndpoint(value);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result.ok ? result.endpoint?.href : undefined;
}

function rejectionFor(value: string): string {
  const result = resolveCoderEndpoint(value);
  assert.equal(result.ok, false, `expected ${value} to be rejected`);
  return result.ok ? "" : result.message;
}

test("no endpoint configured means the vendor default is used", () => {
  for (const value of [undefined, "", "   "]) {
    assert.equal(endpointFor(value), undefined, JSON.stringify(value));
  }
});

test("appends the chat-completions path to an OpenAI base URL", () => {
  // Every compatible server documents the base ending in /v1, so a value
  // copied straight from vLLM's or Ollama's README has to work unchanged.
  assert.equal(endpointFor("https://llm.example.com/v1"), "https://llm.example.com/v1/chat/completions");
  assert.equal(endpointFor("https://llm.example.com/v1/"), "https://llm.example.com/v1/chat/completions");
});

test("leaves a URL that already names the path alone", () => {
  assert.equal(
    endpointFor("https://llm.example.com/v1/chat/completions"),
    "https://llm.example.com/v1/chat/completions",
  );
});

test("allows plain http only for loopback", () => {
  // A request that never leaves the machine has no network to be intercepted
  // on, and demanding a certificate for localhost pushes people toward
  // disabling TLS verification, which is strictly worse.
  assert.equal(endpointFor("http://localhost:8000/v1"), "http://localhost:8000/v1/chat/completions");
  assert.equal(endpointFor("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1/chat/completions");
});

test("refuses plain http to a remote host", () => {
  // The prompt carries the customer's repository content. Every redaction
  // boundary upstream is pointless if the transport itself is in clear text.
  assert.match(rejectionFor("http://llm.example.com/v1"), /https/u);
  assert.match(rejectionFor("http://192.168.1.50:8000/v1"), /https/u);
});

test("refuses credentials embedded in the URL", () => {
  // A URL with a key in it lands in error messages, audit traces and CI logs,
  // none of which redact the endpoint.
  assert.match(rejectionFor("https://user:secret@llm.example.com/v1"), /credentials/iu);
  assert.match(rejectionFor("https://tokenonly@llm.example.com/v1"), /credentials/iu);
});

test("refuses a query string or fragment", () => {
  assert.match(rejectionFor("https://llm.example.com/v1?key=abc"), /query string|fragment/iu);
  assert.match(rejectionFor("https://llm.example.com/v1#anchor"), /query string|fragment/iu);
});

test("refuses a non-http protocol and unparseable input", () => {
  assert.match(rejectionFor("ftp://llm.example.com/v1"), /http/u);
  assert.match(rejectionFor("file:///etc/passwd"), /http/u);
  assert.match(rejectionFor("not a url"), /not a valid URL/u);
});

// --- wiring ---------------------------------------------------------------
// The validator above is worthless if nothing calls it. Three features in this
// repository have shipped complete, correct and unreachable because cli.ts
// never constructed them, so the option is exercised through main() itself.


test("the code command rejects a bad --base-url instead of ignoring it", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { errors.push(parts.join(" ")); };
  try {
    // http to a remote host: refused by resolveCoderEndpoint, and reachable
    // only if cli.ts actually parses and validates the flag.
    const code = await main(["code", ".", "objective", "--model", "openai/gpt-oss-120b", "--base-url", "http://llm.example.com/v1"]);
    assert.equal(code, 2);
    assert.ok(errors.some((line) => /https/u.test(line)), `expected an https complaint, got: ${errors.join(" | ")}`);
  } finally {
    console.error = original;
  }
});

test("the code command refuses --base-url against the Anthropic client", async () => {
  // Silently ignoring it would send the repository to the vendor the operator
  // was trying to avoid, with nothing in the output to say so.
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { errors.push(parts.join(" ")); };
  try {
    const code = await main(["code", ".", "objective", "--model", "claude-sonnet-5", "--base-url", "https://llm.example.com/v1"]);
    assert.equal(code, 2);
    assert.ok(
      errors.some((line) => /OpenAI-compatible/u.test(line)),
      `expected a provider complaint, got: ${errors.join(" | ")}`,
    );
  } finally {
    console.error = original;
  }
});

// --- self-hosted limits ---------------------------------------------------

test("defaults to a window a 16GB runner can actually serve", () => {
  const result = resolveSelfHostedLimits(undefined, undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.limits : undefined, {
    contextWindowTokens: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
    maxOutputTokensPerTurn: SELF_HOSTED_DEFAULT_MAX_OUTPUT_TOKENS,
  });
});

test("accepts explicit limits", () => {
  const result = resolveSelfHostedLimits("32768", "4096");
  assert.deepEqual(
    result.ok ? result.limits : undefined,
    { contextWindowTokens: 32_768, maxOutputTokensPerTurn: 4_096 },
  );
});

test("refuses an output ceiling that leaves no room for the prompt", () => {
  // Not a ceiling at all: it guarantees truncation on the first turn.
  for (const [context, output] of [["4096", "4096"], ["4096", "8192"]]) {
    const result = resolveSelfHostedLimits(context, output);
    assert.equal(result.ok, false, `${context}/${output}`);
    assert.match(result.ok ? "" : result.message, /smaller than/u);
  }
});

test("refuses nonsense limits rather than silently defaulting", () => {
  for (const value of ["0", "-1", "1.5", "abc", "9999999999"]) {
    assert.equal(resolveSelfHostedLimits(value, undefined).ok, false, value);
    assert.equal(resolveSelfHostedLimits(undefined, value).ok, false, value);
  }
});

test("the code command refuses a window override without --base-url", async () => {
  // Wiring. Accepting it against a vendor would declare a limit that is not
  // the one in force, which is the exact class of silent lie this guards.
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { errors.push(parts.join(" ")); };
  try {
    const code = await main(["code", ".", "objective", "--model", "openai/gpt-oss-120b", "--context-window", "8192"]);
    assert.equal(code, 2);
    assert.ok(
      errors.some((line) => /--base-url/u.test(line)),
      `expected a --base-url complaint, got: ${errors.join(" | ")}`,
    );
  } finally {
    console.error = original;
  }
});

test("the code command rejects a bad --context-window instead of ignoring it", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { errors.push(parts.join(" ")); };
  try {
    const code = await main([
      "code", ".", "objective", "--model", "openai/gpt-oss-120b",
      "--base-url", "http://localhost:11434/v1", "--context-window", "nope",
    ]);
    assert.equal(code, 2);
    assert.ok(
      errors.some((line) => /--context-window must be a positive integer/u.test(line)),
      `got: ${errors.join(" | ")}`,
    );
  } finally {
    console.error = original;
  }
});
