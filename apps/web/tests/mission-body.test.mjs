import assert from "node:assert/strict";
import test from "node:test";
import { missionRoutes } from "../app/api/missions/http.mjs";

for (const oversized of [false, true]) {
  test(`mission intake bounds ${oversized ? "oversized" : "stalled"} streams even when cancellation stalls`, async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { if (oversized) controller.enqueue(new Uint8Array(64001)); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    const handle = missionRoutes({ authenticate: async () => ({}), resolveScope: async () => ({ tenantId: 1, principal: "owner" }),
      database: () => ({ prepare: () => assert.fail("Incomplete intake must not touch mission storage") }), bodyTimeoutMs: 20 });
    const request = new Request("https://atlas.test/api/missions", { method: "POST", body, duplex: "half" });
    let guard;
    try {
      const response = await Promise.race([handle(request), new Promise((_, reject) => {
        guard = setTimeout(() => reject(new Error("Mission intake hung")), 1000);
      })]);
      assert.equal(response.status, oversized ? 413 : 408);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match((await response.json()).message, oversized ? /64 KB/ : /timed out/);
      assert.equal(cancelled, true);
    } finally { clearTimeout(guard); }
  });
}
