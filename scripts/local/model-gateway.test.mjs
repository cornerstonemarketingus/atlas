import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createGateway } from "./model-gateway.mjs";

test("gateway requires authentication, blocks management, and forwards bounded inference", async () => {
  const token = "test-only-".repeat(5);
  const seen = [];
  const server = createGateway({ token, model: "test-model", fetcher: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return Response.json({ choices: [{ message: { content: "hello" } }] }); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    assert.equal((await fetch(`${base}/api/pull`, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "other", messages: [] }) })).status, 400);
    const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }], max_tokens: 99999 }) });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.max_tokens, 1200);
    assert.equal(seen[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
