import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { BoundedJsonHttpTransport, JsonHttpTransportError } from "../src/infrastructure/bounded-json-http-transport.js";

for (const mode of ["disconnect", "trickle"] as const) {
  test(`local transport settles a ${mode} response within its deadline`, { timeout: 5000 }, async t => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"secret":"PRIVATE_RESPONSE');
      if (mode === "disconnect") setTimeout(() => response.destroy(), 20);
      else timer = setInterval(() => response.write("x"), 10);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { clearInterval(timer); server.closeAllConnections(); server.close(); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const transport = new BoundedJsonHttpTransport({ timeoutMs: 150 });
    await assert.rejects(transport.post(new URL(`http://127.0.0.1:${address.port}/v1/chat/completions`), {}), (error: unknown) => {
      assert.ok(error instanceof JsonHttpTransportError);
      assert.equal(error.kind, "network");
      assert.equal(error.message, mode === "disconnect" ? "Model endpoint response interrupted" : "Model endpoint timed out");
      assert.doesNotMatch(error.message, /PRIVATE_RESPONSE/);
      return true;
    });
  });
}
