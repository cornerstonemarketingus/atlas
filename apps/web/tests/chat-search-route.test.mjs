import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__searchRouteEnv; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }
`)}`, import.meta.url);

test("built authenticated chat route searches, recovers by reading, persists and streams the answer", async t => {
  const { sqlite, d1 } = migratedDatabase();
  // Drizzle also consumes D1's raw array projection; reuse the migration fixture.
  const wrap = statement => ({ ...statement, bind: (...values) => wrap(statement.bind(...values)), raw: async () => (await statement.all()).results.map(row => Object.values(row)) });
  globalThis.__searchRouteEnv = { DB: { ...d1, prepare: sql => wrap(d1.prepare(sql)) } };
  const configuration = { ATLAS_OPERATOR_TOKEN: "route-operator-test", ATLAS_GITHUB_TOKEN: "route-github-test", ATLAS_ALLOWED_REPOSITORIES: "owner/repo", ATLAS_CHAT_BASE_URL: "http://127.0.0.1:11434/v1", ATLAS_CHAT_MODEL: "fixture", ATLAS_CHAT_FALLBACK_MODEL: "none" };
  const previous = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  const originalFetch = globalThis.fetch;
  let modelRound = 0; const searches = []; const reads = []; const transcripts = [];
  globalThis.fetch = async (rawUrl, options) => {
    const url = String(rawUrl);
    if (url.startsWith("https://api.github.com/search/code")) {
      searches.push(new URL(url).searchParams.get("q"));
      assert.equal(options.headers.authorization, "Bearer route-github-test");
      return Response.json({ message: "Query validation failed" }, { status: 400 });
    }
    if (url.startsWith("https://api.github.com/repos/owner/repo/contents/")) {
      reads.push(url);
      return Response.json({ type: "file", encoding: "base64", content: Buffer.from("export function handler() { return 42; }").toString("base64") });
    }
    const request = JSON.parse(options.body); transcripts.push(request.messages);
    const tool = { id: "search", type: "function", function: { name: "search_repository_code", arguments: JSON.stringify({ repository: "owner/repo", query: "handler", path: "src", filePath: "src/a.ts" }) } };
    const message = modelRound++ % 2 === 0 ? { content: null, tool_calls: [tool] } : { content: "The handler in src/a.ts returns 42. Search failed; direct file retrieval succeeded." };
    if (!request.stream) return Response.json({ choices: [{ message }] });
    const delta = message.tool_calls ? { tool_calls: [{ index: 0, ...tool }] } : { content: message.content };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch; sqlite.close(); delete globalThis.__searchRouteEnv;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  for (const stream of [false, true]) {
    const response = await worker.fetch(new Request("http://localhost/api/chat", { method: "POST", headers: { authorization: "Bearer route-operator-test", "content-type": "application/json" }, body: JSON.stringify({ message: "Find handler and explain what it returns", repository: "owner/repo", stream }) }), globalThis.__searchRouteEnv, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 200);
    const body = stream ? await response.text() : JSON.stringify(await response.json());
    assert.match(body, /returns 42/); assert.match(body, /Search failed/); assert.doesNotMatch(body, /route-github-test|route-operator-test/);
    if (stream) assert.match(body, /event: done/);
  }
  assert.equal(modelRound, 4); assert.equal(searches.length, 4); assert.equal(reads.length, 2);
  assert.deepEqual(searches.slice(0, 2), ["handler path:src repo:owner/repo", '"handler" path:src repo:owner/repo']);
  assert.ok(transcripts[1].some(message => /export function handler/.test(message.content ?? "")));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE role = 'assistant'").get().n, 2);
});
