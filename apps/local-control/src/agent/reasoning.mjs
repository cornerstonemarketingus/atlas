/**
 * The boundary between what the model thinks and what the operator sees.
 *
 * Private reasoning is useful to the run and dangerous to forward: it is
 * unfiltered, frequently wrong on the way to being right, and on a local model
 * it routinely quotes file contents verbatim. Atlas therefore never persists
 * or streams raw chain-of-thought. It streams *progress about* reasoning, and
 * — only if an operator configures a summarizer — a derived summary.
 */
const THINK_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/giu;
const UNCLOSED_THINK = /<(think|thinking|reasoning)>[\s\S]*$/iu;

/**
 * Removes inline reasoning blocks from an assistant message.
 *
 * Reasoning models served over an OpenAI-compatible endpoint very often emit
 * `<think>…</think>` inside `content` rather than in a separate field, so
 * without this the private reasoning simply *is* the answer the client shows.
 */
export function stripInlineReasoning(text) {
  if (typeof text !== "string") return "";
  return text.replace(THINK_BLOCK, "").replace(UNCLOSED_THINK, "").trim();
}

/** True when a chunk is still inside an unterminated reasoning block. */
export function hasOpenReasoningBlock(text) {
  const opens = (text.match(/<(think|thinking|reasoning)>/giu) ?? []).length;
  const closes = (text.match(/<\/(think|thinking|reasoning)>/giu) ?? []).length;
  return opens > closes;
}

export class ReasoningAccumulator {
  #characters = 0;
  #startedAtMs = null;
  #summarize;

  /**
   * `summarize` is opt-in and receives the raw reasoning. The default returns
   * no content at all — a deployment has to make a deliberate choice before
   * any reasoning-derived text can reach a client.
   */
  constructor({ summarize = null, now = () => Date.now() } = {}) {
    this.#summarize = summarize;
    this.now = now;
  }

  #raw = "";

  record(delta) {
    if (this.#startedAtMs === null) this.#startedAtMs = this.now();
    this.#characters += delta.length;
    // Bounded: the accumulator must not become an unbounded copy of the
    // model's thinking sitting in daemon memory.
    if (this.#summarize) this.#raw = `${this.#raw}${delta}`.slice(-20_000);
  }

  get active() { return this.#startedAtMs !== null; }

  /** A progress line safe to persist and stream. Never contains raw reasoning. */
  summary() {
    if (this.#startedAtMs === null) return null;
    const seconds = Math.max(1, Math.round((this.now() - this.#startedAtMs) / 1000));
    const derived = this.#summarize ? String(this.#summarize(this.#raw) ?? "").slice(0, 400) : "";
    return derived
      ? `Thought for ${seconds}s — ${derived}`
      : `Thought for ${seconds}s (${this.#characters.toLocaleString("en-US")} characters, not shown).`;
  }

  reset() {
    this.#characters = 0;
    this.#startedAtMs = null;
    this.#raw = "";
  }
}

/**
 * Strips provider implementation detail out of an error before it is shown.
 * An operator needs to know what failed and what to do; they do not need the
 * vendor's stack trace, and a URL in the message can carry a key.
 */
export function publicErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s"']+/giu, "[endpoint]")
    .replace(/\b(sk|gsk|ghp|github_pat|xox[abps])[-_][A-Za-z0-9_-]{8,}/giu, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted]")
    .slice(0, 600);
}
