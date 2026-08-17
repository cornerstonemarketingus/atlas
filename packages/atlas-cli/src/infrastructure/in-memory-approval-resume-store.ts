import { randomBytes } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalResumeBinding,
  ApprovalResumeResult,
  ApprovalResumeStore,
  CreatePendingToolApproval,
  IssuedApprovalResume,
  PendingToolApproval,
} from "../domain/approval-resume.js";

const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_CAPACITY = 100;
const TOKEN_BYTES = 32;

export interface InMemoryApprovalResumeStoreOptions {
  readonly clock?: () => number;
  readonly ttlMs?: number;
  readonly capacity?: number;
}

export class ApprovalResumeCapacityError extends Error {
  public readonly code = "APPROVAL_RESUME_CAPACITY_EXCEEDED";

  public constructor(public readonly capacity: number) {
    super(`Approval-resume capacity of ${capacity} has been reached.`);
    this.name = "ApprovalResumeCapacityError";
  }
}

export class InMemoryApprovalResumeStore implements ApprovalResumeStore {
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #capacity: number;
  readonly #pendingByToken = new Map<string, PendingToolApproval>();

  public constructor(options: InMemoryApprovalResumeStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#capacity = options.capacity ?? DEFAULT_CAPACITY;
    assertPositiveInteger(this.#ttlMs, "ttlMs");
    assertPositiveInteger(this.#capacity, "capacity");
  }

  public get size(): number {
    this.#deleteExpired(this.#clock());
    return this.#pendingByToken.size;
  }

  public issue(input: CreatePendingToolApproval): IssuedApprovalResume {
    const now = this.#clock();
    assertSafeTimestamp(now, "clock");
    this.#deleteExpired(now);
    if (this.#pendingByToken.size >= this.#capacity) {
      throw new ApprovalResumeCapacityError(this.#capacity);
    }

    assertIdentifier(input.sessionId, "sessionId");
    assertIdentifier(input.repositoryId, "repositoryId");
    assertIdentifier(input.toolId, "toolId");
    assertIdentifier(input.toolCallId, "toolCallId");
    const expiresAtMs = now + this.#ttlMs;
    assertSafeTimestamp(expiresAtMs, "expiration");
    const pending = freezePending({
      ...input,
      arguments: cloneAndFreeze(input.arguments),
      createdAtMs: now,
      expiresAtMs,
    });
    const token = this.#newToken();
    this.#pendingByToken.set(token, pending);
    return Object.freeze({ token, pending: clonePending(pending) });
  }

  public consume(
    token: string,
    binding: ApprovalResumeBinding,
    decision: ApprovalDecision,
  ): ApprovalResumeResult {
    if (!isDecision(decision) || typeof token !== "string" || token.length === 0) {
      return Object.freeze({ status: "unknown" });
    }
    const pending = this.#pendingByToken.get(token);
    if (pending === undefined) {
      return Object.freeze({ status: "unknown" });
    }
    const now = this.#clock();
    assertSafeTimestamp(now, "clock");
    if (now >= pending.expiresAtMs) {
      this.#pendingByToken.delete(token);
      return Object.freeze({ status: "expired" });
    }
    if (!matches(pending, binding)) {
      return Object.freeze({ status: "binding-mismatch" });
    }

    this.#pendingByToken.delete(token);
    return Object.freeze({ status: decision, pending: clonePending(pending) });
  }

  #newToken(): string {
    let token: string;
    do {
      token = randomBytes(TOKEN_BYTES).toString("base64url");
    } while (this.#pendingByToken.has(token));
    return token;
  }

  #deleteExpired(now: number): void {
    for (const [token, pending] of this.#pendingByToken) {
      if (now >= pending.expiresAtMs) {
        this.#pendingByToken.delete(token);
      }
    }
  }
}

function matches(pending: PendingToolApproval, binding: ApprovalResumeBinding): boolean {
  return pending.sessionId === binding.sessionId
    && pending.repositoryId === binding.repositoryId
    && pending.toolId === binding.toolId
    && pending.toolCallId === binding.toolCallId;
}

function isDecision(value: string): value is ApprovalDecision {
  return value === "approved" || value === "rejected" || value === "cancelled";
}

function assertIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new TypeError(`${name} must be a non-empty string of at most 512 characters.`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function assertSafeTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must return a non-negative safe integer.`);
  }
}

function clonePending(pending: PendingToolApproval): PendingToolApproval {
  return freezePending({ ...pending, arguments: cloneAndFreeze(pending.arguments) });
}

function freezePending(pending: PendingToolApproval): PendingToolApproval {
  return Object.freeze(pending);
}

function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  return deepFreeze(clone, new WeakSet<object>());
}

function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested, seen);
    }
    Object.freeze(value);
  }
  return value;
}
