import { createGovernorCore, handleGovernorRequest } from "./inference-governor-core.mjs";

/**
 * One instance per provider quota scope (see app/api/inference/governor-client.mjs),
 * so every isolate, agent and run that shares a provider allowance reserves
 * through the same ledger. SQLite-backed; the ledger is one JSON document.
 * Durable Objects run one request at a time, which is what makes each
 * reservation atomic across isolates.
 */
export class InferenceGovernorObject {
  #core;

  constructor(state) {
    this.#core = createGovernorCore({ storage: state.storage });
  }

  fetch(request) {
    return handleGovernorRequest(this.#core, request);
  }

  /** Drops reservations a crashed caller never released. Alarms are at-least-once; this is idempotent. */
  async alarm() {
    await this.#core.alarm();
  }
}
