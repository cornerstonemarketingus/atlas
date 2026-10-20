import {
  emptyLedgerState, ledgerSnapshot, nextExpiry, observeLedger, releaseReservation, reserveCapacity, withdrawRequest,
} from "../../../packages/atlas-inference/src/index.mjs";

/**
 * The inference governor for one provider quota scope, over any key-value
 * storage with get/put and an alarm (a Durable Object's `ctx.storage`).
 *
 * Kept apart from the Durable Object class so it runs and is tested in plain
 * Node. Each method loads the ledger, applies one operation and saves it; in
 * a Durable Object that sequence is atomic (one request at a time, with
 * input/output gates), which is what makes reservations safe across every
 * Worker isolate.
 */
const KEY = "ledger";

export function createGovernorCore({ storage, now = Date.now }) {
  async function load() {
    const state = await storage.get(KEY);
    return state && state.version === 1 ? state : emptyLedgerState();
  }
  async function save(state) {
    await storage.put(KEY, state);
    // Wake to drop reservations a crashed caller never released.
    const expiry = nextExpiry(state);
    if (expiry !== null) await storage.setAlarm(expiry);
  }
  async function apply(operation) {
    const state = await load();
    const result = operation(state, now());
    await save(state);
    return result;
  }
  return {
    reserve: (request) => apply((state, at) => reserveCapacity(state, request, at)),
    release: (outcome) => apply((state, at) => releaseReservation(state, { ...outcome, headers: outcome.headers ? new Headers(outcome.headers) : undefined }, at)),
    observe: ({ model, headers }) => apply((state, at) => { observeLedger(state, model, new Headers(headers), at); return { ok: true }; }),
    withdraw: ({ requestId }) => apply((state) => { withdrawRequest(state, requestId); return { ok: true }; }),
    snapshot: () => apply((state, at) => ledgerSnapshot(state, at)),
    /** Alarm handler: prune and re-arm. Safe to run more than once (alarms are at-least-once). */
    alarm: () => apply((state, at) => ledgerSnapshot(state, at)),
  };
}

const METHODS = new Set(["reserve", "release", "observe", "withdraw", "snapshot"]);

/**
 * The governor's wire protocol: POST /<method> with a JSON body, JSON back.
 * Fetch rather than RPC so the class needs nothing from `cloudflare:workers`
 * and the built Worker still loads in plain Node (the render tests do).
 */
export async function handleGovernorRequest(core, request) {
  const method = new URL(request.url).pathname.slice(1);
  if (request.method !== "POST" || !METHODS.has(method)) return new Response("Not found", { status: 404 });
  let argument;
  try { argument = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  return Response.json(await core[method](argument));
}
