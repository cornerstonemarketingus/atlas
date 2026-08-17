import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ChangeSetApprovalBinding,
  ChangeSetApprovalConsumeResult,
  ChangeSetApprovalDecision,
  ChangeSetApprovalRequest,
  ChangeSetApprovalResumeStore,
  IssuedChangeSetApproval,
  PendingChangeSetApproval,
  PersistedChangeSetApprovalRecord,
} from "../domain/change-set-approval.js";

const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_CAPACITY = 100;
const TOKEN_BYTES = 32;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export interface InMemoryChangeSetApprovalStoreOptions {
  readonly clock?: () => number;
  readonly ttlMs?: number;
  readonly capacity?: number;
  /** Metadata-only snapshots from a previous process; raw tokens are never restored. */
  readonly records?: readonly PersistedChangeSetApprovalRecord[];
}

export class ChangeSetApprovalCapacityError extends Error {
  public readonly code = "CHANGE_SET_APPROVAL_CAPACITY_EXCEEDED";
  public constructor(public readonly capacity: number) {
    super(`Change-set approval capacity of ${capacity} has been reached.`);
    this.name = "ChangeSetApprovalCapacityError";
  }
}

/**
 * A process-local resume store. Snapshot records can safely be persisted and
 * restored: token hashes permit later verification without retaining tokens.
 */
export class InMemoryChangeSetApprovalStore implements ChangeSetApprovalResumeStore {
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #capacity: number;
  readonly #recordsByTokenHash = new Map<string, PersistedChangeSetApprovalRecord>();

  public constructor(options: InMemoryChangeSetApprovalStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#capacity = options.capacity ?? DEFAULT_CAPACITY;
    assertPositiveSafeInteger(this.#ttlMs, "ttlMs");
    assertPositiveSafeInteger(this.#capacity, "capacity");
    const now = this.#now();
    for (const record of options.records ?? []) this.#restore(record, now);
  }

  public get size(): number {
    this.#deleteExpired(this.#now());
    return this.#recordsByTokenHash.size;
  }

  public issue(request: ChangeSetApprovalRequest): IssuedChangeSetApproval {
    const now = this.#now();
    this.#deleteExpired(now);
    if (this.#recordsByTokenHash.size >= this.#capacity) throw new ChangeSetApprovalCapacityError(this.#capacity);
    assertRequest(request);
    const token = this.#newToken();
    const tokenHash = hashToken(token);
    const pending = freezePending({
      ...request,
      approvalId: randomUUID(),
      createdAtMs: now,
      expiresAtMs: safeAdd(now, this.#ttlMs),
    });
    this.#recordsByTokenHash.set(tokenHash, freezeRecord({ ...pending, tokenHash, state: "pending" }));
    return Object.freeze({ token, pending: clonePending(pending) });
  }

  public consume(token: string, binding: ChangeSetApprovalBinding, decision: ChangeSetApprovalDecision): ChangeSetApprovalConsumeResult {
    if (typeof token !== "string" || token.length === 0 || !isDecision(decision)) return Object.freeze({ status: "unknown" });
    assertRequest(binding);
    const tokenHash = hashToken(token);
    const record = this.#recordsByTokenHash.get(tokenHash);
    if (!record) return Object.freeze({ status: "unknown" });
    const now = this.#now();
    if (now >= record.expiresAtMs) {
      this.#recordsByTokenHash.delete(tokenHash);
      return Object.freeze({ status: "expired" });
    }
    if (!matches(record, binding)) return Object.freeze({ status: "binding-mismatch" });
    if (record.state !== "pending") return Object.freeze({ status: "replayed" });
    const decided = freezeRecord({ ...record, state: decision, decidedAtMs: now });
    this.#recordsByTokenHash.set(tokenHash, decided);
    return Object.freeze({ status: decision, record: cloneRecord(decided) });
  }

  public snapshot(): readonly PersistedChangeSetApprovalRecord[] {
    this.#deleteExpired(this.#now());
    return Object.freeze([...this.#recordsByTokenHash.values()]
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.approvalId.localeCompare(right.approvalId))
      .map(cloneRecord));
  }

  #restore(input: PersistedChangeSetApprovalRecord, now: number): void {
    assertRecord(input);
    if (input.expiresAtMs <= now) return;
    if (this.#recordsByTokenHash.size >= this.#capacity) throw new ChangeSetApprovalCapacityError(this.#capacity);
    if (this.#recordsByTokenHash.has(input.tokenHash)) throw new TypeError("Persisted change-set approval token hashes must be unique.");
    this.#recordsByTokenHash.set(input.tokenHash, freezeRecord({ ...input }));
  }

  #newToken(): string {
    let token: string;
    do token = randomBytes(TOKEN_BYTES).toString("base64url");
    while (this.#recordsByTokenHash.has(hashToken(token)));
    return token;
  }

  #now(): number {
    const now = this.#clock();
    assertNonNegativeSafeInteger(now, "clock");
    return now;
  }

  #deleteExpired(now: number): void {
    for (const [tokenHash, record] of this.#recordsByTokenHash) {
      if (record.expiresAtMs <= now) this.#recordsByTokenHash.delete(tokenHash);
    }
  }
}

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function matches(record: PersistedChangeSetApprovalRecord, binding: ChangeSetApprovalBinding): boolean {
  return record.sessionId === binding.sessionId && record.repositoryId === binding.repositoryId && record.changeSetDigest === binding.changeSetDigest;
}
function isDecision(value: string): value is ChangeSetApprovalDecision { return value === "approved" || value === "rejected" || value === "cancelled"; }
function assertRequest(value: ChangeSetApprovalRequest): void {
  assertIdentifier(value.sessionId, "sessionId"); assertIdentifier(value.repositoryId, "repositoryId");
  if (typeof value.changeSetDigest !== "string" || !DIGEST_PATTERN.test(value.changeSetDigest)) throw new TypeError("changeSetDigest must be a lowercase SHA-256 hex digest.");
}
function assertRecord(value: PersistedChangeSetApprovalRecord): void {
  assertRequest(value); assertIdentifier(value.approvalId, "approvalId");
  if (typeof value.tokenHash !== "string" || !DIGEST_PATTERN.test(value.tokenHash)) throw new TypeError("tokenHash must be a lowercase SHA-256 hex digest.");
  assertNonNegativeSafeInteger(value.createdAtMs, "createdAtMs"); assertNonNegativeSafeInteger(value.expiresAtMs, "expiresAtMs");
  if (value.expiresAtMs <= value.createdAtMs || (value.state !== "pending" && !isDecision(value.state))) throw new TypeError("Persisted approval record is invalid.");
  if (value.state === "pending" ? value.decidedAtMs !== undefined : value.decidedAtMs === undefined) throw new TypeError("Persisted approval decision timestamp is invalid.");
  if (value.decidedAtMs !== undefined) assertNonNegativeSafeInteger(value.decidedAtMs, "decidedAtMs");
}
function assertIdentifier(value: string, name: string): void { if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) throw new TypeError(`${name} must be a non-empty string of at most 512 characters.`); }
function assertPositiveSafeInteger(value: number, name: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer.`); }
function assertNonNegativeSafeInteger(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer.`); }
function safeAdd(left: number, right: number): number { const sum = left + right; assertNonNegativeSafeInteger(sum, "expiration"); return sum; }
function freezePending(value: PendingChangeSetApproval): PendingChangeSetApproval { return Object.freeze(value); }
function freezeRecord(value: PersistedChangeSetApprovalRecord): PersistedChangeSetApprovalRecord { return Object.freeze(value); }
function clonePending(value: PendingChangeSetApproval): PendingChangeSetApproval { return freezePending({ ...value }); }
function cloneRecord(value: PersistedChangeSetApprovalRecord): PersistedChangeSetApprovalRecord { return freezeRecord({ ...value }); }
