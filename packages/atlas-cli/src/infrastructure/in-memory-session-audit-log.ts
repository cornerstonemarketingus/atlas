import {
  SESSION_EVENT_SCHEMA_VERSION,
  type SessionAuditLog,
  type SessionEvent,
  type SessionEventPayloadMap,
  type SessionEventType,
} from "../domain/session-audit.js";

const DEFAULT_MAX_EVENTS = 10_000;

export class SessionAuditOverflowError extends Error {
  public readonly code = "SESSION_AUDIT_CAPACITY_EXCEEDED";

  public constructor(public readonly capacity: number) {
    super(`Session audit log capacity of ${capacity} events has been reached.`);
    this.name = "SessionAuditOverflowError";
  }
}

export interface InMemorySessionAuditLogOptions {
  readonly maxEvents?: number;
  readonly clock?: () => Date;
}

export class InMemorySessionAuditLog implements SessionAuditLog {
  readonly #events: SessionEvent[] = [];
  readonly #clock: () => Date;
  public readonly capacity: number;

  public constructor(options: InMemorySessionAuditLogOptions = {}) {
    const capacity = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("maxEvents must be a positive safe integer.");
    }
    this.capacity = capacity;
    this.#clock = options.clock ?? (() => new Date());
  }

  public get size(): number {
    return this.#events.length;
  }

  public append<T extends SessionEventType>(
    type: T,
    payload: SessionEventPayloadMap[T],
  ): SessionEvent<T> {
    if (this.#events.length >= this.capacity) {
      throw new SessionAuditOverflowError(this.capacity);
    }

    const occurredAt = this.#clock().toISOString();
    const event = Object.freeze({
      schemaVersion: SESSION_EVENT_SCHEMA_VERSION,
      sequence: this.#events.length + 1,
      occurredAt,
      type,
      payload: cloneAndFreeze(payload),
    }) as SessionEvent<T>;
    this.#events.push(event);
    return event;
  }

  public snapshot(): readonly SessionEvent[] {
    return Object.freeze([...this.#events]);
  }
}

function cloneAndFreeze<T>(value: T): Readonly<T> {
  // Audit payload contracts contain JSON-like metadata only. structuredClone
  // prevents callers from retaining mutable references to recorded metadata.
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
