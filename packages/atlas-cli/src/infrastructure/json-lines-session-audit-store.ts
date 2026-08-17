import { appendFile, lstat, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SESSION_EVENT_SCHEMA_VERSION,
  type SessionEvent,
  type SessionEventPayloadMap,
  type SessionEventType,
} from "../domain/session-audit.js";

const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

export type TruncatedTailPolicy = "reject" | "ignore";

export interface JsonLinesSessionAuditStoreOptions {
  readonly filePath: string;
  readonly maxEvents?: number;
  readonly maxLineBytes?: number;
  readonly maxFileBytes?: number;
  readonly createParentDirectories?: boolean;
  readonly truncatedTailPolicy?: TruncatedTailPolicy;
  readonly clock?: () => Date;
}

export class SessionAuditStorageError extends Error {
  public constructor(
    public readonly code:
      | "AUDIT_FILE_TOO_LARGE"
      | "AUDIT_LINE_TOO_LARGE"
      | "AUDIT_EVENT_LIMIT_EXCEEDED"
      | "AUDIT_INVALID_EVENT"
      | "AUDIT_INVALID_SEQUENCE"
      | "AUDIT_TRUNCATED_TAIL"
      | "AUDIT_PATH_NOT_FILE"
      | "AUDIT_PATH_SYMLINK",
    message: string,
    public readonly line?: number,
  ) {
    super(message);
    this.name = "SessionAuditStorageError";
  }
}

/** Append-only, process-serialized persistence for metadata-only session events. */
export class JsonLinesSessionAuditStore {
  public readonly filePath: string;
  public readonly capacity: number;
  readonly #maxLineBytes: number;
  readonly #maxFileBytes: number;
  readonly #createParents: boolean;
  readonly #tailPolicy: TruncatedTailPolicy;
  readonly #clock: () => Date;
  #events: SessionEvent[] | undefined;
  #ignoredTruncatedTail = false;
  #operation: Promise<void> = Promise.resolve();

  public constructor(options: JsonLinesSessionAuditStoreOptions) {
    if (options.filePath.trim().length === 0) throw new TypeError("filePath must not be empty.");
    this.filePath = resolve(options.filePath);
    this.capacity = positiveInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, "maxEvents");
    this.#maxLineBytes = positiveInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
    this.#maxFileBytes = positiveInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
    this.#createParents = options.createParentDirectories ?? true;
    this.#tailPolicy = options.truncatedTailPolicy ?? "reject";
    this.#clock = options.clock ?? (() => new Date());
  }

  public async load(): Promise<readonly SessionEvent[]> {
    return this.#serialize(async () => Object.freeze([...(await this.#loadUnlocked())]));
  }

  public async append<T extends SessionEventType>(
    type: T,
    payload: SessionEventPayloadMap[T],
  ): Promise<SessionEvent<T>> {
    return this.#serialize(async () => {
      const events = await this.#loadUnlocked();
      if (this.#ignoredTruncatedTail) {
        throw new SessionAuditStorageError("AUDIT_TRUNCATED_TAIL", "Cannot append while an ignored truncated tail remains on disk.");
      }
      if (events.length >= this.capacity) {
        throw new SessionAuditStorageError("AUDIT_EVENT_LIMIT_EXCEEDED", `Audit event limit of ${this.capacity} reached.`);
      }
      const event = {
        schemaVersion: SESSION_EVENT_SCHEMA_VERSION,
        sequence: events.length + 1,
        occurredAt: this.#clock().toISOString(),
        type,
        payload: structuredClone(payload),
      } as SessionEvent<T>;
      validateEvent(event, event.sequence);
      const line = `${JSON.stringify(event)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > this.#maxLineBytes) {
        throw new SessionAuditStorageError("AUDIT_LINE_TOO_LARGE", `Serialized audit event exceeds ${this.#maxLineBytes} bytes.`);
      }
      const existingBytes = await this.#existingFileSize();
      if (existingBytes + lineBytes > this.#maxFileBytes) {
        throw new SessionAuditStorageError("AUDIT_FILE_TOO_LARGE", `Audit file would exceed ${this.#maxFileBytes} bytes.`);
      }
      if (this.#createParents) await mkdir(dirname(this.filePath), { recursive: true });
      await this.#assertSafeTarget();
      await appendFile(this.filePath, line, { encoding: "utf8", flag: "a" });
      const frozen = deepFreeze(event) as SessionEvent<T>;
      events.push(frozen);
      return frozen;
    });
  }

  async #loadUnlocked(): Promise<SessionEvent[]> {
    if (this.#events !== undefined) return this.#events;
    await this.#assertSafeTarget();
    let bytes: number;
    try { bytes = (await stat(this.filePath)).size; } catch (error) {
      if (isNotFound(error)) return (this.#events = []);
      throw error;
    }
    if (bytes > this.#maxFileBytes) throw new SessionAuditStorageError("AUDIT_FILE_TOO_LARGE", `Audit file exceeds ${this.#maxFileBytes} bytes.`);
    const content = await readFile(this.filePath, "utf8");
    const hasUnterminatedTail = content.length > 0 && !content.endsWith("\n");
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const events: SessionEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const lineNumber = index + 1;
      if (Buffer.byteLength(line) + 1 > this.#maxLineBytes) throw new SessionAuditStorageError("AUDIT_LINE_TOO_LARGE", `Audit line ${lineNumber} exceeds ${this.#maxLineBytes} bytes.`, lineNumber);
      if (line.trim().length === 0) throw new SessionAuditStorageError("AUDIT_INVALID_EVENT", `Audit line ${lineNumber} is empty.`, lineNumber);
      try {
        const parsed: unknown = JSON.parse(line);
        validateEvent(parsed, events.length + 1, lineNumber);
        events.push(deepFreeze(parsed as SessionEvent) as SessionEvent);
      } catch (error) {
        if (hasUnterminatedTail && index === lines.length - 1 && this.#tailPolicy === "ignore" && error instanceof SyntaxError) {
          this.#ignoredTruncatedTail = true;
          break;
        }
        if (error instanceof SessionAuditStorageError) throw error;
        const code = hasUnterminatedTail && index === lines.length - 1 ? "AUDIT_TRUNCATED_TAIL" : "AUDIT_INVALID_EVENT";
        throw new SessionAuditStorageError(code, `Invalid JSON on audit line ${lineNumber}.`, lineNumber);
      }
      if (events.length > this.capacity) throw new SessionAuditStorageError("AUDIT_EVENT_LIMIT_EXCEEDED", `Audit file exceeds ${this.capacity} events.`);
    }
    this.#events = events;
    return events;
  }

  async #existingFileSize(): Promise<number> {
    try { return (await stat(this.filePath)).size; } catch (error) { if (isNotFound(error)) return 0; throw error; }
  }

  async #assertSafeTarget(): Promise<void> {
    try {
      const info = await lstat(this.filePath);
      if (info.isSymbolicLink()) throw new SessionAuditStorageError("AUDIT_PATH_SYMLINK", "Audit file must not be a symbolic link.");
      if (!info.isFile()) throw new SessionAuditStorageError("AUDIT_PATH_NOT_FILE", "Audit path must identify a regular file.");
    } catch (error) { if (!isNotFound(error)) throw error; }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

const payloadKeys: Record<SessionEventType, readonly string[]> = {
  "session.started": ["sessionId", "repositoryId"],
  "session.completed": ["sessionId", "summary"], "session.blocked": ["sessionId", "summary"], "session.failed": ["sessionId", "summary"],
  "model.requested": ["requestId", "providerId", "modelId", "messageCount", "inputCharacters", "toolsOffered", "contentDigest"],
  "model.responded": ["requestId", "responseId", "finishReason", "inputTokens", "outputTokens", "outputCharacters", "toolCallCount", "contentDigest"],
  "tool.requested": ["requestId", "toolCallId", "toolId", "argumentCount", "argumentsDigest"],
  "tool.policy_decided": ["toolCallId", "decision", "ruleId", "reason"],
  "tool.completed": ["toolCallId", "outcome", "durationMs", "resultCharacters", "resultDigest", "errorCode"],
  "budget.updated": ["inputTokens", "outputTokens", "toolCalls", "elapsedMs", "costMicrounits"],
  "approval.recorded": ["approvalId", "toolCallId", "decision", "actorId", "reason"],
  "error.recorded": ["code", "summary", "recoverable", "relatedId"],
};

function validateEvent(value: unknown, expectedSequence: number, line?: number): asserts value is SessionEvent {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "sequence", "occurredAt", "type", "payload"]) || value["schemaVersion"] !== SESSION_EVENT_SCHEMA_VERSION || value["sequence"] !== expectedSequence || typeof value["occurredAt"] !== "string" || !Number.isFinite(Date.parse(value["occurredAt"])) || typeof value["type"] !== "string" || !(value["type"] in payloadKeys) || !isRecord(value["payload"])) {
    const sequenceWrong = isRecord(value) && value["sequence"] !== expectedSequence;
    throw new SessionAuditStorageError(sequenceWrong ? "AUDIT_INVALID_SEQUENCE" : "AUDIT_INVALID_EVENT", `Invalid audit event${line === undefined ? "" : ` on line ${line}`}.`, line);
  }
  const type = value["type"] as SessionEventType;
  if (!hasAllowedKeys(value["payload"] as Record<string, unknown>, payloadKeys[type]) || !validatePayload(type, value["payload"] as Record<string, unknown>)) throw new SessionAuditStorageError("AUDIT_INVALID_EVENT", `Invalid ${type} payload${line === undefined ? "" : ` on line ${line}`}.`, line);
}

function validatePayload(type: SessionEventType, p: Record<string, unknown>): boolean {
  const s = (key: string, optional = false): boolean => optional && p[key] === undefined || typeof p[key] === "string";
  const n = (key: string): boolean => Number.isSafeInteger(p[key]) && (p[key] as number) >= 0;
  switch (type) {
    case "session.started": return s("sessionId") && s("repositoryId", true);
    case "session.completed": case "session.blocked": case "session.failed": return s("sessionId") && s("summary");
    case "model.requested": return s("requestId") && s("providerId") && s("modelId") && n("messageCount") && n("inputCharacters") && n("toolsOffered") && s("contentDigest", true);
    case "model.responded": return s("requestId") && s("responseId", true) && s("finishReason") && n("inputTokens") && n("outputTokens") && n("outputCharacters") && n("toolCallCount") && s("contentDigest", true);
    case "tool.requested": return s("requestId") && s("toolCallId") && s("toolId") && n("argumentCount") && s("argumentsDigest", true);
    case "tool.policy_decided": return s("toolCallId") && ["allow", "ask", "deny"].includes(String(p["decision"])) && s("ruleId", true) && s("reason");
    case "tool.completed": return s("toolCallId") && ["succeeded", "failed", "cancelled"].includes(String(p["outcome"])) && n("durationMs") && n("resultCharacters") && s("resultDigest", true) && s("errorCode", true);
    case "budget.updated": return n("inputTokens") && n("outputTokens") && n("toolCalls") && n("elapsedMs") && n("costMicrounits");
    case "approval.recorded": return s("approvalId") && s("toolCallId") && ["approved", "rejected", "cancelled"].includes(String(p["decision"])) && s("actorId", true) && s("reason", true);
    case "error.recorded": return s("code") && s("summary") && typeof p["recoverable"] === "boolean" && s("relatedId", true);
  }
}

function positiveInteger(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && hasAllowedKeys(value, keys); }
function hasAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function isNotFound(error: unknown): boolean { return isRecord(error) && error["code"] === "ENOENT"; }
function deepFreeze<T>(value: T): Readonly<T> { if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
