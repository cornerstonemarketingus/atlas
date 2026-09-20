import assert from "node:assert/strict";
import test from "node:test";

import { detectHardware } from "../src/agent/models/hardware.mjs";
import { discoverModelServers, inferContextWindow } from "../src/agent/models/discovery.mjs";
import { recommendModels, CANDIDATES } from "../src/agent/models/recommend.mjs";
import { fitToContext, usableContextCharacters, estimateTokens, describeContextFailure } from "../src/agent/models/context-fit.mjs";
import { measure } from "../src/agent/compaction.mjs";
import { createModelRouter, describeRoutes, parseRoutes, NoRouteError, ROUTABLE_TASKS } from "../src/agent/models/router.mjs";
import { evaluateModel, EVALUATIONS } from "../src/agent/models/evaluations.mjs";
import { ContextTooLargeError } from "../src/agent/compaction.mjs";
import { ModelRequestError } from "../src/agent/model-client.mjs";

test("hardware detection reports what the machine can hold and survives a missing GPU", async () => {
  const hardware = await detectHardware({ runCommandImpl: async () => ({ ok: false, stdout: "", stderr: "not found" }) });
  assert.ok(hardware.cpuCount >= 1);
  assert.ok(hardware.totalMemoryGiB > 0);
  assert.deepEqual(hardware.gpus, [], "no GPU is a normal result, not a failure");
  assert.equal(hardware.usableModelMemoryGiB, hardware.totalMemoryGiB, "without a discrete GPU, system memory is the limit");

  const withGpu = await detectHardware({
    runCommandImpl: async (command) => (command === "nvidia-smi"
      ? { ok: true, stdout: "NVIDIA GeForce RTX 4090, 24564\n", stderr: "" }
      : { ok: false, stdout: "", stderr: "" }),
  });
  assert.equal(withGpu.gpus[0].vendor, "nvidia");
  assert.equal(withGpu.gpus[0].memoryGiB, 24);
  assert.equal(withGpu.usableModelMemoryGiB, 24, "with a discrete GPU, VRAM is the limit");
});

test("discovery finds Ollama and OpenAI-compatible servers and labels guessed context windows", async () => {
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.endsWith("/api/tags") && target.includes("11434")) {
      return Response.json({ models: [{ name: "qwen2.5-coder:7b", size: 4_700_000_000, details: { parameter_size: "7B", quantization_level: "Q4_K_M" } }] });
    }
    if (target.endsWith("/v1/models") && target.includes("8080")) {
      return Response.json({ data: [{ id: "llama3.1-8b-instruct" }, { id: "some-unknown-model" }] });
    }
    return new Response("nope", { status: 404 });
  };

  const servers = await discoverModelServers({ endpoints: ["http://127.0.0.1:11434/v1", "http://127.0.0.1:8080/v1", "http://127.0.0.1:9999/v1"], fetchImpl });
  assert.equal(servers.length, 2, "a server that is not running is skipped, not an error");

  const ollama = servers.find((server) => server.kind === "ollama");
  assert.equal(ollama.models[0].name, "qwen2.5-coder:7b");
  assert.equal(ollama.models[0].quantization, "Q4_K_M");
  assert.equal(ollama.models[0].contextWindow, 32_768);
  assert.equal(ollama.models[0].source, "inferred");

  const compatible = servers.find((server) => server.kind === "openai-compatible");
  assert.equal(compatible.models.find((model) => model.name === "llama3.1-8b-instruct").contextWindow, 131_072);
  // An unrecognised model gets a conservative window, labelled as assumed —
  // guessing high is what produces silent truncation.
  const unknown = compatible.models.find((model) => model.name === "some-unknown-model");
  assert.equal(unknown.contextWindow, 8_192);
  assert.equal(unknown.source, "assumed");
  assert.equal(inferContextWindow("mistral-7b").contextWindow, 32_768);
});

test("a non-loopback discovery endpoint over plain HTTP is skipped", async () => {
  const servers = await discoverModelServers({
    endpoints: ["http://models.example.invalid/v1"],
    fetchImpl: async () => assert.fail("an insecure endpoint must never be contacted"),
  });
  assert.deepEqual(servers, []);
});

test("recommendations follow the memory the machine actually has", () => {
  const small = recommendModels({ hardware: { usableModelMemoryGiB: 8 }, installed: [{ name: "qwen2.5-coder:7b" }] });
  assert.equal(small.recommendations.coding.selected, "qwen2.5-coder:7b");
  assert.match(small.recommendations.coding.reason, /both installed and the best fit/u);

  const large = recommendModels({ hardware: { usableModelMemoryGiB: 24 }, installed: [{ name: "qwen2.5-coder:7b" }] });
  assert.equal(large.recommendations.coding.selected, "qwen2.5-coder:7b", "it uses what is installed");
  assert.equal(large.recommendations.coding.recommended, "qwen2.5-coder:32b", "and says what would be better");
  assert.match(large.recommendations.coding.reason, /would fit this machine and do better/u);

  const tiny = recommendModels({ hardware: { usableModelMemoryGiB: 1 }, installed: [] });
  assert.equal(tiny.recommendations.coding.recommended, null);
  assert.match(tiny.recommendations.coding.reason, /below what any coding model/u);

  const noVision = recommendModels({ hardware: { usableModelMemoryGiB: 16 }, installed: [{ name: "qwen2.5-coder:7b" }] });
  assert.equal(noVision.recommendations.vision.selected, null);
  assert.match(noVision.recommendations.vision.reason, /pull it to enable vision/u);

  // The largest model that fits is the one recommended, whatever order the
  // candidate list happens to be written in.
  for (const task of ROUTABLE_TASKS) {
    for (const memory of [2, 4, 8, 12, 16, 24, 64]) {
      const report = recommendModels({ hardware: { usableModelMemoryGiB: memory }, installed: [] });
      const recommended = report.recommendations[task].recommended;
      const fitting = CANDIDATES.filter((candidate) => candidate.tasks.includes(task) && candidate.minimumMemoryGiB <= memory);
      if (fitting.length === 0) {
        assert.equal(recommended, null, `${task} at ${memory} GiB should recommend nothing`);
        continue;
      }
      const largest = fitting.reduce((best, candidate) => (candidate.parametersB > best.parametersB ? candidate : best));
      assert.equal(recommended, largest.name, `${task} at ${memory} GiB should recommend the largest model that fits`);
    }
  }
});

test("a prompt that fits is sent, one that does not is compacted, and one that cannot is refused", () => {
  const small = [{ role: "user", content: "hello" }];
  const fitted = fitToContext(small, { contextWindow: 8_192 });
  assert.equal(fitted.compacted, false);
  assert.equal(fitted.messages, small);

  const long = [
    { role: "system", content: "You are Atlas.", pinned: true },
    { role: "user", content: "OBJECTIVE: ship the release." },
    ...Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "user" : "assistant", content: `chatter ${index} ${"x".repeat(400)}` })),
    { role: "user", content: "What is left?" },
  ];
  const compacted = fitToContext(long, { contextWindow: 4_096, maxOutputTokens: 512 });
  assert.equal(compacted.compacted, true);
  assert.match(compacted.note, /earlier messages were summarized/u);
  assert.match(compacted.messages.map((message) => message.content).join(" "), /OBJECTIVE: ship the release/u);

  // A single message larger than the window cannot be compacted away.
  assert.throws(
    () => fitToContext([{ role: "system", content: "x".repeat(200_000) }], { contextWindow: 4_096 }),
    ContextTooLargeError,
  );
  assert.ok(usableContextCharacters({ contextWindow: 8_192, maxOutputTokens: 2_048 }) > 0);
  assert.ok(estimateTokens(3_600) >= 1_000);
});

test("a refused context explains itself in numbers an operator can act on", () => {
  const message = describeContextFailure(new ContextTooLargeError(40_000, 8_000), {
    model: "qwen2.5-coder:7b",
    contextWindow: 8_192,
    contextSource: "assumed",
  });
  assert.match(message, /40,000 tokens/u);
  assert.match(message, /8,000/u);
  assert.match(message, /Nothing was sent/u);
  assert.match(message, /is assumed, not reported by the server/u, "the operator is told the window may itself be a guess");

  const measured = describeContextFailure(new ContextTooLargeError(40_000, 8_000), { model: "m", contextWindow: 8_192, contextSource: "measured" });
  assert.equal(measured.includes("not reported by the server"), false);
});

test("routing falls back within a task and stops at terminal failures", async () => {
  const attempts = [];
  const router = createModelRouter({
    routes: [
      { task: "coding", model: "first", endpoint: "http://127.0.0.1:11434/v1" },
      { task: "coding", model: "second", endpoint: "http://127.0.0.1:8080/v1" },
      { task: "vision", model: "eyes", endpoint: "http://127.0.0.1:11434/v1" },
    ],
    createClient: (route) => ({ model: route.model }),
  });

  // The first route fails transiently; the second answers.
  const recovered = await router.run("coding", async (client) => {
    attempts.push(client.model);
    if (client.model === "first") throw new ModelRequestError("MODEL_REQUEST_FAILED", "connection reset");
    return "answered";
  });
  assert.deepEqual(attempts, ["first", "second"]);
  assert.equal(recovered.value, "answered");
  assert.equal(recovered.route.model, "second");

  // An authentication failure is terminal: the second route is never tried.
  attempts.length = 0;
  await assert.rejects(
    () => router.run("coding", async (client) => { attempts.push(client.model); throw new ModelRequestError("MODEL_NOT_AUTHORIZED", "bad key"); }),
    (error) => error.code === "MODEL_NOT_AUTHORIZED",
  );
  assert.deepEqual(attempts, ["first"], "authentication failures do not fall through");

  // So is invalid input.
  attempts.length = 0;
  await assert.rejects(
    () => router.run("coding", async (client) => { attempts.push(client.model); throw new ModelRequestError("MODEL_INVALID_INPUT", "bad request"); }),
    (error) => error.code === "MODEL_INVALID_INPUT",
  );
  assert.deepEqual(attempts, ["first"]);

  // Every route failing transiently produces one actionable diagnostic.
  await assert.rejects(
    () => router.run("coding", async () => { throw new ModelRequestError("MODEL_REQUEST_FAILED", "server is down"); }),
    (error) => error instanceof NoRouteError && /first: .*server is down/u.test(error.message) && /second:/u.test(error.message),
  );

  await assert.rejects(() => router.run("summarization", async () => "x"), (error) => error.code === "NO_ROUTE");
});

test("route configuration is parsed strictly and described without naming a vendor", () => {
  const routes = parseRoutes(JSON.stringify([
    { task: "coding", model: "qwen2.5-coder:7b", endpoint: "http://127.0.0.1:11434/v1", contextWindow: 32768 },
    { task: "planning", model: "remote-model", endpoint: "https://models.example.invalid/v1" },
    { task: "nonsense", model: "x", endpoint: "y" },
    { model: "missing-task", endpoint: "z" },
  ]));
  assert.equal(routes.length, 2, "unknown tasks and incomplete routes are dropped");
  assert.equal(routes[0].contextSource, "configured", "an explicit window is not a guess");
  assert.equal(routes[1].contextSource, "inferred");
  assert.deepEqual(parseRoutes("not json"), []);

  const router = createModelRouter({ routes, createClient: () => ({}) });
  const described = describeRoutes(router);
  const flattened = JSON.stringify(described);
  assert.match(flattened, /this machine/u, "a loopback route reads as local");
  assert.match(flattened, /models\.example\.invalid/u, "a remote route names its host so the operator can tell");
  assert.equal(flattened.includes("http://"), false, "no raw endpoint URLs in customer-facing copy");
});

test("routing rejects an unknown task at construction rather than at runtime", () => {
  assert.throws(() => createModelRouter({ routes: [{ task: "telepathy", model: "m", endpoint: "e" }], createClient: () => ({}) }), /Unknown routing task/u);
  assert.throws(() => createModelRouter({ routes: [{ task: "coding", model: "m" }], createClient: () => ({}) }), /needs an endpoint and a model/u);
});

test("the evaluation fixtures tell an operator whether a model can be trusted with tools", async () => {
  const good = {
    async *stream({ messages, tools }) {
      const prompt = messages[0].content;
      if (/Read the file README/u.test(prompt)) {
        yield { type: "tool_call", id: "c1", name: "repository.read", arguments: '{"path":"README.md"}' };
      } else if (/2 \+ 2/u.test(prompt)) {
        yield { type: "text", delta: "Four" };
      } else if (/Oslo/u.test(prompt)) {
        yield { type: "text", delta: '```json\n{"city":"Oslo","country":"Norway","population_millions":0.7}\n```' };
      } else {
        yield { type: "text", delta: "READY" };
      }
      yield { type: "done", finishReason: "stop", usage: null };
      assert.ok(Array.isArray(tools));
    },
  };
  const passing = await evaluateModel({ client: good, model: "good-model" });
  assert.equal(passing.passed, EVALUATIONS.length);
  assert.equal(passing.toolCallingUsable, true);
  assert.equal(passing.structuredOutputUsable, true);

  // A model that chats instead of calling tools fails the tool checks, and is
  // reported as unusable for tools rather than merely "scored lower".
  const chatty = {
    async *stream() {
      yield { type: "text", delta: "Sure! I would read README.md for you." };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
  const failing = await evaluateModel({ client: chatty, model: "chatty-model" });
  assert.equal(failing.toolCallingUsable, false);
  assert.equal(failing.structuredOutputUsable, false);
  assert.match(failing.results[0].detail, /answered in prose instead of calling the tool/u);

  // A model that calls a tool when none is needed also fails, in the other direction.
  const eager = {
    async *stream() {
      yield { type: "tool_call", id: "c1", name: "repository.read", arguments: '{"path":"README.md"}' };
      yield { type: "done", finishReason: "stop", usage: null };
    },
  };
  const eagerReport = await evaluateModel({ client: eager, model: "eager-model" });
  assert.match(eagerReport.results.find((result) => result.id === "tool-call-restraint").detail, /called a tool for a question that needed none/u);

  // A model whose endpoint is down is reported, not thrown.
  const broken = { async *stream() { throw new ModelRequestError("MODEL_REQUEST_FAILED", "connection refused"); } };
  const brokenReport = await evaluateModel({ client: broken, model: "broken-model" });
  assert.equal(brokenReport.passed, 0);
  assert.match(brokenReport.results[0].detail, /connection refused/u);
});


test("the tool schemas come out of the context budget", () => {
  // Tools ride along on every request and are not in the message array, so
  // measuring only the messages left them out of the budget entirely. On a
  // small window they are a large share of it, and the result was a prompt
  // that passed this check and was then truncated by the server.
  const toolCharacters = 10_864; // the real size of Atlas's registered families
  const withTools = usableContextCharacters({ contextWindow: 8_192, reservedCharacters: toolCharacters });
  const withoutTools = usableContextCharacters({ contextWindow: 8_192 });
  assert.ok(withTools < withoutTools);
  // The schemas are taken out in tokens and the remainder is scaled back to
  // characters, so the gap is the schemas' token cost rather than their
  // character count. Those differ whenever the conversation's own ratio is
  // not the schemas' ratio, which is the usual case.
  assert.ok(Math.abs((withoutTools - withTools) - toolCharacters) <= 4, `expected roughly ${toolCharacters}, got ${withoutTools - withTools}`);

  // A conversation that fits by the message-only measure but not once the
  // tools are counted must now be refused rather than sent. Written as prose,
  // because the budget is scaled by what the text actually costs and prose is
  // the content that gets the most characters per token.
  const prose = "The operator asked for a change and the runtime recorded it. ".repeat(250);
  const messages = [{ role: "system", content: "S", pinned: true }, { role: "user", content: prose }];
  assert.equal(fitToContext(messages, { contextWindow: 8_192 }).compacted, false, "fits when tools are ignored");
  assert.throws(
    () => fitToContext(messages, { contextWindow: 8_192, reservedCharacters: toolCharacters }),
    ContextTooLargeError,
    "refused once the tools are counted",
  );

  // Tools alone larger than the window cannot be fixed by compacting messages.
  assert.throws(
    () => fitToContext([{ role: "user", content: "hi" }], { contextWindow: 4_096, reservedCharacters: 60_000 }),
    ContextTooLargeError,
  );
});

test("a refused context compares two numbers in the same unit", () => {
  // The message reported token counts labelled as characters, so the two
  // figures in it were not comparable.
  const messages = [{ role: "system", content: "x".repeat(200_000), pinned: true }];
  try {
    fitToContext(messages, { contextWindow: 8_192 });
    assert.fail("should have refused");
  } catch (error) {
    assert.equal(error.code, "CONTEXT_TOO_LARGE");
    assert.equal(error.unit, "tokens");
    assert.match(error.message, /tokens after compaction/u);
    assert.equal(error.message.includes("characters"), false);
    assert.ok(error.required > error.available);
  }
});

test("an inline image attachment is measured, not smuggled past the budget", () => {
  // Attachments become base64 data URLs inside the message content. An 8MB
  // image is ~11M characters; if `measure()` did not walk into structured
  // content, it would pass through and be truncated at the server.
  const base64 = "A".repeat(1_000_000);
  const messages = [
    { role: "system", content: "You are Atlas.", pinned: true },
    { role: "user", content: [
      { type: "text", text: "What is in this screenshot?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
    ] },
  ];
  assert.ok(measure(messages) > 1_000_000, "the image is counted");
  assert.throws(() => fitToContext(messages, { contextWindow: 32_768 }), ContextTooLargeError);
});

test("the context budget is scaled by what the text actually costs", async () => {
  const { charactersPerToken, estimateTokensForText } = await import("../src/agent/models/token-estimate.mjs");

  // One constant of 3.6 characters per token was applied to everything. It is
  // about right for English and badly optimistic for what an operator agent
  // mostly handles, and a prompt that far over the window is truncated by the
  // server rather than refused here.
  const samples = {
    prose: { text: "The operator asked for a change and the runtime recorded it as an event. ".repeat(30), realRatio: 4.0 },
    json: { text: JSON.stringify({ tools: Array.from({ length: 30 }, (u, i) => ({ name: `tool_${i}`, parameters: { type: "object", properties: { path: { type: "string" } } } })) }), realRatio: 2.8 },
    base64: { text: Buffer.from("x".repeat(3_000)).toString("base64"), realRatio: 2.2 },
    japanese: { text: "このセッションは再起動をまたいで開いたままになります。".repeat(30), realRatio: 1.1 },
    chinese: { text: "会话在重启后保持打开状态并流式传输事件。".repeat(30), realRatio: 1.0 },
  };

  for (const [name, { text, realRatio }] of Object.entries(samples)) {
    const estimated = charactersPerToken(text);
    // Estimating at or below the real rate is what keeps the budget honest:
    // too low wastes context, too high silently truncates.
    assert.ok(estimated <= realRatio * 1.15, `${name}: estimated ${estimated.toFixed(2)} against a real ${realRatio}`);
    assert.ok(estimated > 0.5, `${name}: the estimate collapsed to nothing`);
  }

  // The old constant would have given the same budget to all five.
  assert.ok(charactersPerToken(samples.chinese.text) < charactersPerToken(samples.prose.text) / 3);
  assert.equal(estimateTokensForText(""), 0);
  assert.ok(estimateTokensForText("a") >= 1, "a non-empty string never costs nothing");

  // The same conversation, in two languages, gets two different budgets.
  const window = { contextWindow: 8_192, maxOutputTokens: 2_048 };
  const forProse = usableContextCharacters({ ...window, charactersPerToken: charactersPerToken(samples.prose.text) });
  const forChinese = usableContextCharacters({ ...window, charactersPerToken: charactersPerToken(samples.chinese.text) });
  assert.ok(forChinese < forProse / 3, `${forChinese} characters against ${forProse}`);
});

test("a Chinese conversation is compacted rather than sent over the window", async () => {
  const { estimateTokensForText } = await import("../src/agent/models/token-estimate.mjs");

  // Sized to pass the old 3.6-characters-per-token check while really being
  // well over the window.
  const line = "会话在重启后保持打开状态并向已连接的客户端流式传输规范化的事件记录。";
  const messages = [
    { role: "system", content: "You are Atlas.", pinned: true },
    { role: "user", content: "请帮我部署。" },
    ...Array.from({ length: 40 }, (unused, index) => ({ role: index % 2 === 0 ? "assistant" : "user", content: line.repeat(8) })),
  ];

  const characters = messages.reduce((total, message) => total + message.content.length, 0);
  assert.ok(Math.ceil(characters / 3.6) < 5_529, "the old ratio said this fits");
  assert.ok(estimateTokensForText(messages.map((message) => message.content).join("")) > 5_529, "it does not");

  const fitted = fitToContext(messages, { contextWindow: 8_192, maxOutputTokens: 2_048 });
  assert.equal(fitted.compacted, true, "sent whole, the server would have dropped the start of it");
  assert.ok(fitted.charactersPerToken < 1.2, `budgeted at ${fitted.charactersPerToken} characters per token`);
  assert.match(fitted.note, /earlier messages were summarized/u);
});

test("the token ratio is calibrated from what the server reports", async () => {
  const { createTokenRatioCalibrator, charactersPerToken } = await import("../src/agent/models/token-estimate.mjs");
  const calibrator = createTokenRatioCalibrator();
  const text = "The operator asked for a change. ".repeat(50);

  // With nothing measured, the estimate stands.
  assert.equal(calibrator.ratioFor("qwen", text), charactersPerToken(text));
  assert.equal(calibrator.measuredFor("qwen"), null);

  // The server counted the prompt, and Atlas knows what it sent. This model
  // turns out to be hungrier than the estimate.
  calibrator.record("qwen", { characters: 10_000, promptTokens: 5_000 });
  assert.equal(calibrator.measuredFor("qwen"), 2);
  assert.equal(calibrator.ratioFor("qwen", text), 2, "a measurement that says the budget is too generous is believed at once");

  // A model that is more generous than the estimate does not widen the budget
  // on one observation, because being wrong that way is what truncates.
  const generous = createTokenRatioCalibrator();
  generous.record("gpt", { characters: 10_000, promptTokens: 1_000 });
  assert.ok(generous.ratioFor("gpt", text) <= charactersPerToken(text));

  // Nonsense from the server is ignored rather than poisoning the budget.
  assert.equal(calibrator.record("qwen", { characters: 0, promptTokens: 10 }), null);
  assert.equal(calibrator.record("qwen", { characters: 10, promptTokens: 0 }), null);
  assert.equal(calibrator.record("qwen", { characters: NaN, promptTokens: 10 }), null);
  assert.equal(calibrator.measuredFor("qwen"), 2, "the bad readings changed nothing");
});
