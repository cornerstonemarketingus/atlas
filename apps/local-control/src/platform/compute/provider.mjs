/**
 * GPU provider interface (issue #353, engineering plan §3.2) and the fake
 * provider every test runs against. There is no real adapter yet: that waits
 * on the owner's choice of provider and monthly cap.
 *
 * A provider is any object with a `name` and these async methods:
 *
 *   estimate(job)  -> { gpuType, estHourlyUsd, estMinutes } | null
 *       `job.minVramGb` is the floor the GPU must meet. Returns null when the
 *       provider has no GPU that fits.
 *   provision({ gpuType, maxLifetimeSec, tags }) -> instance
 *       `maxLifetimeSec` MUST be enforced by the provider itself, so billing
 *       stops even if Atlas has crashed. `tags` is a list of strings; every
 *       Atlas instance carries ATLAS_TAG.
 *   status(instanceId) -> instance | null
 *   terminate(instanceId) -> instance | null     (idempotent)
 *   listTagged(tag) -> instance[]                (only instances still billing)
 *
 * An instance is { id, gpuType, state: "running" | "terminated", tags,
 * billedMicroUsd, terminationReason? }. `billedMicroUsd` is the integer cost
 * so far (final once terminated), or null when the provider cannot say; a
 * null final cost is settled as the full reservation.
 */

export const ATLAS_TAG = "atlas";
export const PROVIDER_METHODS = Object.freeze(["estimate", "provision", "status", "terminate", "listTagged"]);

export class ComputeProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ComputeProviderError";
    this.code = code;
  }
}

/** Throws unless `provider` implements the whole interface and has a name. */
export function assertProvider(provider) {
  if (!provider || typeof provider.name !== "string" || !provider.name) throw new ComputeProviderError("INVALID_PROVIDER", "A compute provider needs a name.");
  for (const method of PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") throw new ComputeProviderError("INVALID_PROVIDER", `Compute provider '${provider.name}' is missing ${method}().`);
  }
  return provider;
}

/** Integer micro-dollars per second for an hourly price, rounded up so a reservation never under-covers. */
export function microUsdPerSecond(hourlyUsd) {
  if (!Number.isFinite(hourlyUsd) || hourlyUsd <= 0) throw new ComputeProviderError("INVALID_PRICE", "An hourly GPU price must be a positive number.");
  return Math.ceil((hourlyUsd * 1_000_000) / 3600);
}

/** A manually advanced clock in milliseconds, shared by the fake provider and the manager in tests. */
export class FakeClock {
  #ms;
  constructor(startMs = Date.UTC(2026, 0, 1)) { this.#ms = startMs; }
  now() { return this.#ms; }
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("A fake clock only moves forward.");
    this.#ms += ms;
    return this.#ms;
  }
}

export const DEFAULT_FAKE_CATALOG = Object.freeze([
  Object.freeze({ gpuType: "fake-t4-16gb", vramGb: 16, hourlyUsd: 0.4 }),
  Object.freeze({ gpuType: "fake-a10-24gb", vramGb: 24, hourlyUsd: 0.75 }),
  Object.freeze({ gpuType: "fake-a100-80gb", vramGb: 80, hourlyUsd: 1.9 }),
]);

/**
 * In-memory provider that behaves like a per-second-billing GPU cloud: it
 * bills every started second while an instance runs, and stops (and stops
 * billing) an instance on its own once `maxLifetimeSec` has passed, whether
 * or not anyone calls it. It makes no network calls and spends nothing.
 * `failProvision` / `failTerminate` inject provider failures for tests.
 */
export class FakeGpuProvider {
  #clock;
  #catalog;
  #instances = new Map();
  #seq = 0;
  failProvision = false;
  failTerminate = false;

  constructor({ name = "fake", clock, catalog = DEFAULT_FAKE_CATALOG } = {}) {
    if (!clock || typeof clock.now !== "function") throw new ComputeProviderError("INVALID_ARGUMENT", "FakeGpuProvider needs a clock.");
    this.name = name;
    this.#clock = clock;
    this.#catalog = catalog.map(entry => ({ ...entry }));
  }

  /** Every provision call that created an instance so far (for tests). */
  get provisionCount() { return this.#seq; }

  async estimate(job) {
    const minVram = job?.minVramGb ?? 0;
    const fit = this.#catalog.filter(entry => entry.vramGb >= minVram).sort((a, b) => a.hourlyUsd - b.hourlyUsd)[0];
    if (!fit) return null;
    return { gpuType: fit.gpuType, estHourlyUsd: fit.hourlyUsd, estMinutes: Math.max(1, Math.ceil(job?.estMinutes ?? 10)) };
  }

  async provision({ gpuType, maxLifetimeSec, tags = [] }) {
    if (this.failProvision) throw new ComputeProviderError("PROVIDER_UNAVAILABLE", "Fake provider refused to provision.");
    const entry = this.#catalog.find(candidate => candidate.gpuType === gpuType);
    if (!entry) throw new ComputeProviderError("UNKNOWN_GPU", `Fake provider has no GPU '${gpuType}'.`);
    if (!Number.isInteger(maxLifetimeSec) || maxLifetimeSec <= 0) throw new ComputeProviderError("INVALID_ARGUMENT", "maxLifetimeSec must be a positive integer.");
    this.#seq += 1;
    const record = {
      id: `fake-gpu-${this.#seq}`, gpuType, tags: [...tags], maxLifetimeSec,
      rate: microUsdPerSecond(entry.hourlyUsd), startedAt: this.#clock.now(), endedAt: null, terminationReason: null,
    };
    this.#instances.set(record.id, record);
    return this.#view(record);
  }

  async status(instanceId) {
    const record = this.#instances.get(instanceId);
    return record ? this.#view(record) : null;
  }

  async terminate(instanceId) {
    if (this.failTerminate) throw new ComputeProviderError("PROVIDER_UNAVAILABLE", "Fake provider failed to terminate.");
    const record = this.#instances.get(instanceId);
    if (!record) return null;
    this.#expire(record);
    if (record.endedAt === null) { record.endedAt = this.#clock.now(); record.terminationReason = "requested"; }
    return this.#view(record);
  }

  async listTagged(tag) {
    return [...this.#instances.values()].map(record => this.#view(record)).filter(view => view.state === "running" && view.tags.includes(tag));
  }

  /** Instances still billing, regardless of tags (for tests). */
  running() {
    return [...this.#instances.values()].map(record => this.#view(record)).filter(view => view.state === "running");
  }

  /** Total billed across every instance ever created (for tests). */
  totalBilledMicroUsd() {
    return [...this.#instances.values()].reduce((sum, record) => sum + this.#view(record).billedMicroUsd, 0);
  }

  // Provider-side max lifetime, applied lazily. Observably the same as a
  // provider timer: nothing can read the instance between deadline and check.
  #expire(record) {
    if (record.endedAt !== null) return;
    const deadline = record.startedAt + record.maxLifetimeSec * 1000;
    if (this.#clock.now() >= deadline) { record.endedAt = deadline; record.terminationReason = "max_lifetime"; }
  }

  #view(record) {
    this.#expire(record);
    const end = record.endedAt ?? this.#clock.now();
    const seconds = Math.min(record.maxLifetimeSec, Math.ceil(Math.max(0, end - record.startedAt) / 1000));
    return {
      id: record.id, gpuType: record.gpuType, tags: [...record.tags],
      state: record.endedAt === null ? "running" : "terminated",
      billedMicroUsd: seconds * record.rate,
      ...(record.terminationReason ? { terminationReason: record.terminationReason } : {}),
    };
  }
}
