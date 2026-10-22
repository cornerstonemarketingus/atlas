import assert from "node:assert/strict";
import test from "node:test";
import { missionRequest } from "../app/missions/request.mjs";
for (const phase of ["headers", "body"]) {
  test(`mission deadline bounds stalled ${phase} even when cancellation is ignored`, { timeout: 2000 }, async () => {
    let calls = 0; let signal;
    const hanging = new Promise(() => {});
    const fetchImpl = async (_path, input) => { calls++; signal = input.signal; return phase === "headers" ? hanging : { ok: true, json: () => hanging }; };
    await assert.rejects(missionRequest("/api/missions/id", { action: "advance" }, { fetchImpl, timeoutMs: 20 }), /Work may have started.*reconcile/);
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1, "never replay a possibly accepted task");
  });
}
test("mission read timeout offers recovery and server rejection preserves its explanation", async () => {
  await assert.rejects(missionRequest("/api/missions", undefined, { fetchImpl: () => new Promise(() => {}), timeoutMs: 20 }), /loading timed out/);
  await assert.rejects(missionRequest("/api/missions", {}, { fetchImpl: async () => Response.json({ message: "Task allowance exhausted" }, { status: 429 }) }), /Task allowance exhausted/);
  assert.deepEqual(await missionRequest("/api/missions", undefined, { fetchImpl: async () => Response.json({ missions: [] }) }), { missions: [] });
});
