import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionAuditLog } from "../domain/session-audit.js";
import type { SecretRedactor } from "../domain/secret-redaction.js";
import { PatternSecretRedactor } from "./pattern-secret-redactor.js";
import { JsonLinesSessionAuditStore } from "./json-lines-session-audit-store.js";

export interface CoderProgressRecorderOptions {
  readonly filePath?: string;
  readonly audit?: SessionAuditLog;
  readonly auditLogPath?: string;
  readonly checkpoint?: () => Promise<unknown>;
  readonly redactor?: SecretRedactor;
}

/** Atomic redacted snapshots and incremental audit flushes survive interrupted runs. */
export class CoderProgressRecorder {
  readonly #redactor: SecretRedactor;
  readonly #store: JsonLinesSessionAuditStore | undefined;
  #operation: Promise<void> = Promise.resolve();
  #persisted = 0;

  public constructor(private readonly options: CoderProgressRecorderOptions) {
    this.#redactor = options.redactor ?? new PatternSecretRedactor();
    this.#store = options.auditLogPath === undefined ? undefined : new JsonLinesSessionAuditStore({ filePath: options.auditLogPath, redactor: this.#redactor });
  }

  public save(state: object): Promise<void> {
    // Capture the caller's state now; later writes must not mutate an earlier checkpoint.
    const snapshot = structuredClone(state);
    const events = this.options.audit?.snapshot() ?? [];
    const save = async () => {
      await this.options.checkpoint?.();
      if (this.#store !== undefined) {
        for (const event of events.slice(this.#persisted)) {
          await this.#store.append(event.type, event.payload, event.occurredAt);
          this.#persisted += 1;
        }
      }
      if (this.options.filePath === undefined) return;
      const rendered = await this.#redactor.redact(JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString() }));
      // A truncated or invalid snapshot must not replace the last usable checkpoint.
      if (rendered.truncated) throw new Error("Progress snapshot exceeded its redaction bound.");
      JSON.parse(rendered.text);
      const destination = this.options.filePath;
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${rendered.text}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    };
    const result = this.#operation.then(save, save);
    this.#operation = result.catch(() => undefined);
    return result;
  }
}
