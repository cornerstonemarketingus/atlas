import type {
  AssistantContent,
  InputContent,
  JsonValue,
  ModelCompletionOptions,
  ModelMessage,
  ModelProvider,
  ModelProviderMetadata,
  ModelRequest,
  ModelResponse,
} from "../model/model-provider.js";
import { SECRET_REDACTION_SCHEMA_VERSION, summarizeRedaction } from "../domain/secret-redaction.js";
import type {
  SecretCategory,
  SecretRedactionSummary,
  SecretRedactor,
} from "../domain/secret-redaction.js";

/**
 * How many distinct strings to remember. A coder session replays its whole
 * transcript on every turn, so without a cache the same system prompt and the
 * same file contents are re-scanned on turn after turn. The bound keeps a long
 * session from growing this without limit.
 */
const DEFAULT_MAX_CACHE_ENTRIES = 512;

export interface RedactingModelProviderOptions {
  readonly maxCacheEntries?: number;
  /** Called after each request with what was removed, for audit or reporting. */
  readonly onRedaction?: (summary: SecretRedactionSummary) => void;
}

/**
 * Scrubs credentials from every request on its way to a model provider.
 *
 * This is the last boundary before bytes leave the process for a third party,
 * and it is the only one that sees *everything*: the system prompt, the
 * objective, deterministic repository evidence, tool results, and the
 * validation output fed back as repair feedback. Redacting at each of those
 * call sites instead would mean five places to get right and one place to
 * forget; a failing test that prints a credential ("expected 'sk-live-…' to
 * equal …") reaches the model through the repair path, not the tool path, and
 * would have slipped past a tool-only defence.
 *
 * Wrap the raw provider with this OUTSIDE the retry decorator, so a retried
 * request is not re-scanned on every attempt.
 */
export class RedactingModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  readonly #provider: ModelProvider;
  readonly #redactor: SecretRedactor;
  readonly #maxCacheEntries: number;
  readonly #cache = new Map<string, { readonly text: string; readonly summary: SecretRedactionSummary }>();
  #redactionCount = 0;

  public constructor(
    provider: ModelProvider,
    redactor: SecretRedactor,
    private readonly options: RedactingModelProviderOptions = {},
  ) {
    this.#provider = provider;
    this.metadata = provider.metadata;
    this.#redactor = redactor;
    this.#maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    if (!Number.isInteger(this.#maxCacheEntries) || this.#maxCacheEntries < 1) {
      throw new RangeError("maxCacheEntries must be a positive integer.");
    }
  }

  /** Total secrets removed across every request this instance has forwarded. */
  public get redactionCount(): number {
    return this.#redactionCount;
  }

  public async complete(request: ModelRequest, options?: ModelCompletionOptions): Promise<ModelResponse> {
    // Accumulated per request rather than derived from a counter delta, so the
    // reported summary is the real one: which categories were found, how much
    // text was actually scanned, and whether any part of it hit the scan bound.
    // A summary that under-reports truncation would be worse than none — it
    // would assert coverage the scan did not have.
    const tally = new RedactionTally();
    const messages = await this.#redactMessages(request.messages, tally);
    if (tally.redactionCount > 0 || tally.truncated) this.options.onRedaction?.(tally.summarize());
    // The response is deliberately NOT redacted; see #redactAssistant.
    return this.#provider.complete({ ...request, messages }, options);
  }

  async #redactMessages(messages: readonly ModelMessage[], tally: RedactionTally): Promise<readonly ModelMessage[]> {
    const redacted: ModelMessage[] = [];
    for (const message of messages) {
      if (message.role === "system") {
        redacted.push({ ...message, content: await this.#redactText(message.content, tally) });
      } else if (message.role === "user") {
        redacted.push({ ...message, content: await this.#redactInput(message.content, tally) });
      } else if (message.role === "tool") {
        redacted.push({ ...message, content: await this.#redactInput(message.content, tally) });
      } else {
        redacted.push({ ...message, content: await this.#redactAssistant(message.content, tally) });
      }
    }
    return redacted;
  }

  async #redactText(content: readonly { readonly type: "text"; readonly text: string }[], tally: RedactionTally) {
    const out = [];
    for (const part of content) out.push({ ...part, text: await this.#scrub(part.text, tally) });
    return out;
  }

  async #redactInput(content: readonly InputContent[], tally: RedactionTally): Promise<readonly InputContent[]> {
    const out: InputContent[] = [];
    for (const part of content) {
      out.push(part.type === "text"
        ? { ...part, text: await this.#scrub(part.text, tally) }
        : { ...part, value: await this.#scrubJson(part.value, tally) });
    }
    return out;
  }

  /**
   * Assistant TEXT is scrubbed; assistant TOOL-CALL ARGUMENTS are not, and that
   * asymmetry is deliberate.
   *
   * A tool call's arguments carry the file content the model asked to write. A
   * placeholder substituted there would either be written into the customer's
   * repository verbatim, or — worse — be read back by the model on a later turn
   * and "restored" over the real content. Redaction would corrupt data rather
   * than prevent a leak.
   *
   * Nor does skipping them open a hole. Repository content only reaches the
   * model through the tool registry, which redacts on the way out, so anything
   * the model copies from a file is already a placeholder before it can be
   * echoed into an argument. A credential in a tool call is therefore one the
   * model itself invented, not one belonging to the customer.
   *
   * The same reasoning applies to the response: it is the model's own output,
   * and its tool calls are dispatched directly to the editor.
   */
  async #redactAssistant(content: readonly AssistantContent[], tally: RedactionTally): Promise<readonly AssistantContent[]> {
    const out: AssistantContent[] = [];
    for (const part of content) {
      out.push(part.type === "text" ? { ...part, text: await this.#scrub(part.text, tally) } : part);
    }
    return out;
  }

  async #scrubJson(value: JsonValue, tally: RedactionTally): Promise<JsonValue> {
    if (typeof value === "string") return this.#scrub(value, tally);
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      for (const item of value) out.push(await this.#scrubJson(item, tally));
      return out;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, JsonValue> = {};
      // Keys are scrubbed as well as values: a credential can appear as an
      // object key in a parsed config or lockfile, not only as a value.
      for (const [key, item] of Object.entries(value)) out[await this.#scrub(key, tally)] = await this.#scrubJson(item, tally);
      return out;
    }
    return value;
  }

  async #scrub(text: string, tally: RedactionTally): Promise<string> {
    if (text.length === 0) return text;
    const cached = this.#cache.get(text);
    // A cache hit still counts. The cache exists to avoid re-scanning, not to
    // make a repeated secret vanish from the tally — the same credential
    // replayed on ten turns is ten times it was about to leave the process.
    if (cached !== undefined) {
      tally.add(cached.summary);
      return cached.text;
    }

    const result = await this.#redactor.redact(text);
    this.#redactionCount += result.redactionCount;
    tally.add(result);
    // Least-recently-inserted eviction. A precise LRU would need reordering on
    // every hit; insertion order alone is enough here, because the transcript
    // grows by appending and the oldest strings are the ones that stop
    // recurring first.
    if (this.#cache.size >= this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(text, { text: result.text, summary: summarizeRedaction(result) });
    return result.text;
  }
}

/** Accumulates per-request findings so the reported summary is measured, not inferred. */
class RedactionTally {
  readonly #counts = new Map<SecretCategory, number>();
  #scanned = 0;
  #truncated = false;
  #redactions = 0;

  public get redactionCount(): number {
    return this.#redactions;
  }

  public get truncated(): boolean {
    return this.#truncated;
  }

  public add(summary: SecretRedactionSummary): void {
    this.#redactions += summary.redactionCount;
    this.#scanned += summary.scannedCharacters;
    this.#truncated ||= summary.truncated;
    for (const finding of summary.findings) {
      this.#counts.set(finding.category, (this.#counts.get(finding.category) ?? 0) + finding.count);
    }
  }

  public summarize(): SecretRedactionSummary {
    return {
      schemaVersion: SECRET_REDACTION_SCHEMA_VERSION,
      redactionCount: this.#redactions,
      // Sorted so two runs over the same input produce comparable records.
      findings: [...this.#counts]
        .map(([category, count]) => ({ category, count }))
        .sort((left, right) => left.category.localeCompare(right.category)),
      scannedCharacters: this.#scanned,
      truncated: this.#truncated,
    };
  }
}
