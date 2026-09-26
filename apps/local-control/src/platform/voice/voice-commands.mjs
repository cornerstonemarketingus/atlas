import { digest } from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Voice command interface (blueprint §13 L).
 *
 * Sits on top of the existing speech transcriber (src/agent/speech.mjs,
 * `createSpeechTranscriber`) — or any object with
 * `transcribe({ audio, mediaType }) => { text, confidence? }` — and turns a
 * transcript into one of a small set of intents:
 *
 *   create_task · status · approve · cancel · emergency_stop
 *
 * Safety rules:
 *  - Nothing is done on a low-confidence transcript. When the transcriber
 *    reports no confidence (the stock whisper endpoint does not), only
 *    read-only intents (status) are served unless the operator configures
 *    `unknownConfidence`.
 *  - Consequential intents (approve, cancel, emergency stop — and anything
 *    marked consequential) are never executed on the first utterance. Atlas
 *    reads back what it is about to do and a short code derived from the
 *    action's digest; the user must say "confirm <code>" within the TTL.
 *    The confirmation is bound to that exact action digest: a code for one
 *    action cannot confirm another, a code is single-use, and a new
 *    consequential request replaces any pending one.
 *  - Speech output is short, plain text with no ids, URLs or markup, so it
 *    can be read aloud.
 *
 * Transcripts are parsed here by fixed patterns only; no model sees them.
 * TODO(untrusted): a `create_task` objective is spoken, untrusted text. When
 * a handler forwards it into a model turn it must be wrapped with
 * `wrapUntrusted` from src/agent/untrusted.mjs (not yet on this base).
 */

export const INTENTS = Object.freeze(["create_task", "status", "approve", "cancel", "emergency_stop"]);
export const CONSEQUENTIAL_INTENTS = Object.freeze(["approve", "cancel", "emergency_stop"]);
const READ_ONLY_INTENTS = new Set(["status"]);

export class VoiceCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VoiceCommandError";
    this.code = code;
  }
}

const NUMBER_WORDS = {
  zero: "0", oh: "0", o: "0", one: "1", won: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4",
  five: "5", six: "6", seven: "7", eight: "8", ate: "8", nine: "9",
};

/** Lower-case, strip punctuation, collapse whitespace. */
export function normalizeTranscript(text) {
  return String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** "confirm four seven one two" / "confirm 4 7 1 2" / "confirm 4712" → "4712". */
function spokenDigits(words) {
  let out = "";
  for (const word of words) {
    if (/^\d+$/u.test(word)) out += word;
    else if (NUMBER_WORDS[word] !== undefined) out += NUMBER_WORDS[word];
    else if (out) break;
  }
  return out;
}

/** Parses a normalized transcript into `{ intent, ... }` or `{ intent: null }`. */
export function parseIntent(rawText) {
  const text = normalizeTranscript(rawText).replace(/^(hey |ok |okay )?atlas,? /u, "").replace(/^please /u, "");
  if (!text) return { intent: null, text };
  let m;
  if ((m = /^confirm(?:ed)?\b(.*)$/u.exec(text))) {
    return { intent: "confirm", code: spokenDigits(m[1].trim().split(" ").filter(Boolean)), text };
  }
  if (/^(never ?mind|abort confirmation|don't|do not)\b/u.test(text)) return { intent: "dismiss", text };
  if (/\b(emergency stop|stop everything|stop all (agents|tasks)|halt everything|kill switch)\b/u.test(text)) {
    return { intent: "emergency_stop", text };
  }
  if ((m = /^(?:approve|accept)\s+(?:the\s+)?(?:approval|request)?\s*(?:for\s+)?(.+)$/u.exec(text))) {
    return { intent: "approve", target: m[1].trim(), text };
  }
  if ((m = /^(?:cancel|stop)\s+(?:the\s+)?(?:task\s+)?(.+)$/u.exec(text))) {
    return { intent: "cancel", target: m[1].trim(), text };
  }
  if ((m = /^(?:create|start|new|add)\s+(?:a\s+)?(?:new\s+)?task\s*(?:to\s+|that\s+|:\s*)?(.+)$/u.exec(text))) {
    return { intent: "create_task", objective: m[1].trim(), text };
  }
  if ((m = /^(?:what(?:'s| is) the )?(?:status|progress)(?:\s+(?:of|on|for)\s+(?:the\s+)?(?:task\s+)?(.+))?$/u.exec(text))
    || (m = /^how(?:'s| is) (?:the\s+)?(?:task\s+)?(.+?)? ?going$/u.exec(text))) {
    return { intent: "status", target: m[1]?.trim() || null, text };
  }
  return { intent: null, text };
}

/**
 * Short, speakable progress line for a task: no ids, no URLs, at most
 * `maxWords` words.
 * @param task { objective, status, stepsDone?, stepsTotal?, costMicroUsd?, pendingApprovals?, lastError? }
 */
export function progressUpdate(task, { maxWords = 30 } = {}) {
  if (!task) return "I could not find that task.";
  const objective = speakable(task.objective ?? "your task", 8);
  const parts = [`${capitalize(objective)} is ${String(task.status ?? "unknown").replaceAll("_", " ")}`];
  if (Number.isInteger(task.stepsTotal) && task.stepsTotal > 0) parts.push(`${task.stepsDone ?? 0} of ${task.stepsTotal} steps done`);
  if (Number.isInteger(task.pendingApprovals) && task.pendingApprovals > 0) {
    parts.push(`${task.pendingApprovals} approval${task.pendingApprovals === 1 ? "" : "s"} waiting for you`);
  }
  if (Number.isFinite(task.costMicroUsd) && task.costMicroUsd > 0) parts.push(`spent ${spokenMoney(task.costMicroUsd)}`);
  if (task.lastError) parts.push(`last problem: ${speakable(task.lastError, 6)}`);
  const sentence = `${parts.join(", ")}.`;
  const words = sentence.split(" ");
  return words.length <= maxWords ? sentence : `${words.slice(0, maxWords).join(" ").replace(/[,.]$/u, "")}.`;
}

function speakable(text, maxWords) {
  const clean = String(text)
    .replace(/https?:\/\/\S+/gu, "a link")
    .replace(/\b(tsk|stp|tcl|agt|art|apr|evt|cor|wks|pol|msg)_[0-9a-f]{8,}\b/gu, "")
    .replace(/[`*_#>[\]{}|~]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "");
  const words = clean.split(" ").filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

function spokenMoney(micro) {
  const cents = Math.round(micro / 10_000);
  if (cents < 1) return "less than a cent";
  if (cents < 100) return `${cents} cent${cents === 1 ? "" : "s"}`;
  const dollars = (cents / 100).toFixed(2).replace(/\.00$/u, "");
  return `${dollars} dollars`;
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Four spoken digits derived from the action digest. */
export function confirmationCode(actionDigest, length = 4) {
  const hex = actionDigest.replace(/^sha256:/u, "").slice(0, 12);
  return String(Number.parseInt(hex, 16) % 10 ** length).padStart(length, "0");
}

export class VoiceCommandInterface {
  #transcriber;
  #handlers;
  #clock;
  #minConfidence;
  #ttlMs;
  #unknownConfidence;
  #pending = null;
  #log = [];

  /**
   * @param handlers { createTask({ objective }), status({ target }), approve({ target, actionDigest }),
   *   cancel({ target, actionDigest }), emergencyStop({ actionDigest }), resolveTarget?({ intent, target }) }
   *   each returning `{ speech?, ... }`. resolveTarget maps spoken references ("the invoice task") to
   *   a concrete `{ id, label }` so the confirmation binds to a real object.
   * @param unknownConfidence 'read_only' (default) | 'refuse' | a number used as the confidence
   */
  constructor({ transcriber = null, handlers = {}, clock = () => new Date(), minConfidence = 0.8, confirmationTtlMs = 30_000, unknownConfidence = "read_only", consequentialIntents = CONSEQUENTIAL_INTENTS } = {}) {
    this.#transcriber = transcriber;
    this.#handlers = handlers;
    this.#clock = clock;
    this.#minConfidence = minConfidence;
    this.#ttlMs = confirmationTtlMs;
    this.#unknownConfidence = unknownConfidence;
    this.consequentialIntents = new Set(consequentialIntents);
  }

  /** Audit trail of every utterance and what was done with it. */
  get log() { return this.#log.map((entry) => ({ ...entry })); }
  get pending() {
    return this.#pending && this.#clock().getTime() < this.#pending.expiresAt
      ? { intent: this.#pending.action.intent, actionDigest: this.#pending.actionDigest, code: this.#pending.code, expiresAt: new Date(this.#pending.expiresAt).toISOString() }
      : null;
  }

  /** Transcribes audio with the configured transcriber, then handles the transcript. */
  async hear({ audio, mediaType, signal, speakerId = null }) {
    if (!this.#transcriber) throw new VoiceCommandError("NO_TRANSCRIBER", "No speech transcriber is configured.");
    const result = await this.#transcriber.transcribe({ audio, mediaType, signal });
    return this.handleTranscript({ text: result.text, confidence: result.confidence, speakerId });
  }

  async handleTranscript({ text, confidence = undefined, speakerId = null }) {
    const now = this.#clock().getTime();
    const parsed = parseIntent(text);
    const record = (outcome) => {
      this.#log.push({ at: new Date(now).toISOString(), speakerId, transcript: String(text ?? ""), confidence: confidence ?? null, intent: parsed.intent, ...outcome });
      return { intent: parsed.intent, ...outcome };
    };

    // Confidence gate.
    let effective = confidence;
    if (typeof effective !== "number") {
      if (typeof this.#unknownConfidence === "number") effective = this.#unknownConfidence;
      else if (this.#unknownConfidence === "read_only" && READ_ONLY_INTENTS.has(parsed.intent)) effective = 1;
      else effective = 0;
    }
    if (effective < this.#minConfidence) {
      return record({ action: "ignored", reason: "low_confidence", speech: "Sorry, I did not catch that clearly. Please say it again." });
    }
    if (!parsed.intent) return record({ action: "ignored", reason: "no_intent", speech: "I did not recognise a command." });

    if (parsed.intent === "dismiss") {
      const had = Boolean(this.#pending);
      this.#pending = null;
      return record({ action: "dismissed", speech: had ? "Okay, I will not do that." : "There was nothing waiting for confirmation." });
    }

    if (parsed.intent === "confirm") return record(await this.#confirm(parsed, now, speakerId));

    // Resolve spoken references to concrete targets before binding a digest.
    let target = parsed.target ?? null;
    let label = parsed.target ?? null;
    if (target && typeof this.#handlers.resolveTarget === "function" && parsed.intent !== "create_task") {
      const resolved = await this.#handlers.resolveTarget({ intent: parsed.intent, target });
      if (!resolved) return record({ action: "rejected", reason: "unknown_target", speech: `I could not find ${speakableTarget(target)}.` });
      target = resolved.id;
      label = resolved.label ?? resolved.id;
    }

    if (this.consequentialIntents.has(parsed.intent)) {
      if (parsed.intent !== "emergency_stop" && !target) {
        return record({ action: "rejected", reason: "missing_target", speech: `Which one should I ${parsed.intent}?` });
      }
      const action = { intent: parsed.intent, target };
      const actionDigest = digest(action);
      const code = confirmationCode(actionDigest);
      this.#pending = { action, label, actionDigest, code, expiresAt: now + this.#ttlMs, speakerId };
      const what = parsed.intent === "emergency_stop" ? "stop every running agent" : `${parsed.intent} ${speakableTarget(label)}`;
      return record({
        action: "awaiting_confirmation", actionDigest, code,
        speech: `To ${what}, say confirm ${code.split("").join(" ")} within ${Math.round(this.#ttlMs / 1000)} seconds.`,
      });
    }

    return record(await this.#execute(parsed.intent, { target, objective: parsed.objective }));
  }

  async #confirm(parsed, now, speakerId) {
    const pending = this.#pending;
    if (!pending) return { action: "rejected", reason: "nothing_pending", speech: "There is nothing waiting for confirmation." };
    if (now >= pending.expiresAt) {
      this.#pending = null;
      return { action: "rejected", reason: "confirmation_expired", actionDigest: pending.actionDigest, speech: "That confirmation expired. Please ask again." };
    }
    if (pending.speakerId && speakerId && pending.speakerId !== speakerId) {
      return { action: "rejected", reason: "different_speaker", speech: "The confirmation must come from the person who asked." };
    }
    if (!parsed.code || parsed.code !== pending.code) {
      return { action: "rejected", reason: "code_mismatch", speech: "That code does not match. Nothing was done." };
    }
    // Re-derive the digest from the stored action: the confirmation authorizes exactly this action.
    const actionDigest = digest(pending.action);
    if (actionDigest !== pending.actionDigest) {
      this.#pending = null;
      return { action: "rejected", reason: "digest_mismatch", speech: "The action changed. Nothing was done." };
    }
    this.#pending = null; // single use
    const result = await this.#execute(pending.action.intent, { target: pending.action.target, actionDigest });
    return { ...result, confirmed: true, actionDigest };
  }

  async #execute(intent, { target = null, objective = undefined, actionDigest = undefined }) {
    const name = { create_task: "createTask", status: "status", approve: "approve", cancel: "cancel", emergency_stop: "emergencyStop" }[intent];
    const handler = this.#handlers[name];
    if (typeof handler !== "function") return { action: "rejected", reason: "not_supported", speech: "I cannot do that by voice yet." };
    if (intent === "create_task" && !objective) return { action: "rejected", reason: "missing_objective", speech: "What should the task do?" };
    try {
      const result = await handler({ target, objective, actionDigest }) ?? {};
      return { action: "executed", result, speech: result.speech ?? defaultSpeech(intent, result) };
    } catch (error) {
      return { action: "failed", error: String(error?.message ?? error), speech: "That did not work. Nothing further was done." };
    }
  }
}

function defaultSpeech(intent, result) {
  if (intent === "status") return result.task ? progressUpdate(result.task) : "I have no status for that.";
  if (intent === "create_task") return "Task created. I will keep you posted.";
  if (intent === "approve") return "Approved.";
  if (intent === "cancel") return "Cancelled.";
  return "Emergency stop sent. All agents are stopping.";
}

function speakableTarget(target) {
  return speakable(String(target), 8) || "that";
}
