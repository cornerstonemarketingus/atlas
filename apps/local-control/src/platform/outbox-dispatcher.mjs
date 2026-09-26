import { randomUUID } from "node:crypto";

/**
 * Delivers the platform's transactional outbox to in-process subscribers.
 *
 * Every task transition, tool call, approval and artifact event is written to
 * the outbox in the same transaction as the change it describes. This loop
 * leases those rows, hands each event to every subscriber whose topic matches,
 * and acknowledges it only when all of them succeeded. A subscriber that
 * throws causes a retry; once a row has used its attempts the store moves it
 * to the dead-letter state, where it stays visible instead of vanishing.
 * Delivery is at-least-once, so subscribers must tolerate a repeated event
 * (every event carries a stable id).
 */
export class OutboxDispatcher {
  #store;
  #workerId;
  #batch;
  #leaseMs;
  #intervalMs;
  #onError;
  #subscribers = new Set();
  #timer = null;
  #draining = null;

  constructor({ store, workerId = `outbox-${randomUUID().slice(0, 8)}`, batch = 50, leaseMs = 30_000, intervalMs = 500, onError = () => {} }) {
    if (!store) throw new TypeError("store is required.");
    this.#store = store;
    this.#workerId = workerId;
    this.#batch = batch;
    this.#leaseMs = leaseMs;
    this.#intervalMs = intervalMs;
    this.#onError = onError;
  }

  get workerId() { return this.#workerId; }

  /**
   * @param {string} topic "*" for everything, "task.*" for a family, or an exact event type
   * @param {(event: object) => void|Promise<void>} handler
   * @returns {() => void} unsubscribe
   */
  subscribe(topic, handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function.");
    const entry = { topic, handler };
    this.#subscribers.add(entry);
    return () => this.#subscribers.delete(entry);
  }

  #matches(topic, type) {
    if (topic === "*") return true;
    if (topic.endsWith(".*")) return type.startsWith(topic.slice(0, -1));
    return topic === type;
  }

  /** Delivers everything currently pending. Concurrent calls share one pass. */
  drain() {
    this.#draining ??= this.#drainOnce().finally(() => { this.#draining = null; });
    return this.#draining;
  }

  async #drainOnce() {
    const totals = { delivered: 0, retried: 0, deadLettered: 0 };
    for (;;) {
      const leased = this.#store.claimOutbox(this.#batch, this.#workerId, this.#leaseMs);
      if (!leased.length) return totals;
      const acked = [];
      for (const row of leased) {
        try {
          for (const { topic, handler } of [...this.#subscribers]) {
            if (this.#matches(topic, row.event.type)) await handler(row.event);
          }
          acked.push(row.id);
        } catch (error) {
          const outcome = this.#store.nackOutbox([row.id], { error: error instanceof Error ? error.message : String(error), workerId: this.#workerId });
          totals.retried += outcome.retried;
          totals.deadLettered += outcome.deadLettered;
          this.#onError(error, row);
        }
      }
      totals.delivered += this.#store.ackOutbox(acked, this.#workerId);
      // Rows that failed are pending again; stop this pass so they wait for the next tick.
      if (acked.length < leased.length) return totals;
    }
  }

  start() {
    if (this.#timer) return;
    const tick = () => {
      this.drain().catch((error) => this.#onError(error, null)).finally(() => {
        if (this.#timer) this.#timer = setTimeout(tick, this.#intervalMs);
      });
    };
    this.#timer = setTimeout(tick, 0);
    this.#timer.unref?.();
  }

  async stop() {
    const timer = this.#timer;
    this.#timer = null;
    if (timer) clearTimeout(timer);
    await this.#draining;
  }
}

/**
 * Fans delivered events out to connected dashboard clients as server-sent
 * events, filtered by tenant. Slow or disconnected clients are dropped rather
 * than allowed to back up delivery for everyone else.
 */
export function createEventStream({ tenantFor, maxClients = 16, maxBuffered = 256 * 1024 }) {
  const clients = new Set();
  return {
    get size() { return clients.size; },
    /** Outbox subscriber. */
    publish(event) {
      const frame = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) {
        if (client.tenantId !== event.tenantId) continue;
        if (client.response.writableLength > maxBuffered) { client.response.end(); clients.delete(client); continue; }
        client.response.write(frame);
      }
    },
    /** HTTP handler for GET /v1/platform/stream (after authentication). */
    attach(request, response, identity) {
      if (clients.size >= maxClients) {
        response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ message: "Too many live dashboard connections. Close another tab and retry." }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      response.write(": connected\n\n");
      const client = { tenantId: tenantFor(identity), response };
      clients.add(client);
      const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
      keepAlive.unref?.();
      request.on("close", () => { clearInterval(keepAlive); clients.delete(client); });
    },
  };
}
