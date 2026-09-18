/**
 * Conversation compaction.
 *
 * A long session eventually exceeds the model's context window, and the naive
 * fix — drop the oldest messages — throws away exactly the things that must
 * survive: the objective, the decisions taken, the approvals granted, and the
 * state of the task. So compaction keeps those explicitly, keeps the recent
 * tail, and replaces the middle with a factual record of what was dropped.
 *
 * It never silently truncates. A caller that cannot fit even the preserved
 * messages is told so, and refuses, rather than sending a prompt that quietly
 * lost half the conversation.
 */
export const PRESERVED_ROLES = new Set(["system"]);

export class ContextTooLargeError extends Error {
  constructor(required, available) {
    super(`The conversation needs ${required} characters after compaction but only ${available} are available.`);
    this.name = "ContextTooLargeError";
    this.code = "CONTEXT_TOO_LARGE";
    this.required = required;
    this.available = available;
  }
}

export function measure(messages) {
  return messages.reduce((total, message) => total + messageCharacters(message), 0);
}

function messageCharacters(message) {
  const content = typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content ?? "");
  return content.length + JSON.stringify(message.tool_calls ?? "").length + 16;
}

/**
 * @param messages OpenAI-format messages. A message may carry `pinned: true`
 *   to mark it as a decision, approval, or task-state record that compaction
 *   must never drop.
 */
export function compactConversation(messages, { maxCharacters, keepRecent = 6 } = {}) {
  if (!Number.isFinite(maxCharacters) || maxCharacters <= 0) throw new Error("maxCharacters must be a positive number.");
  const total = measure(messages);
  if (total <= maxCharacters) return { messages, compacted: false, dropped: 0, summary: null };

  const keep = new Set();
  messages.forEach((message, index) => {
    if (PRESERVED_ROLES.has(message.role) || message.pinned === true) keep.add(index);
  });
  // The first user message is the objective; without it the model is working
  // on a task it can no longer name.
  const firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser !== -1) keep.add(firstUser);
  for (let index = Math.max(0, messages.length - keepRecent); index < messages.length; index += 1) keep.add(index);

  closeToolCallPairs(messages, keep);

  const dropped = messages.filter((_, index) => !keep.has(index));
  if (dropped.length === 0) {
    // Nothing is droppable and it still does not fit.
    throw new ContextTooLargeError(total, maxCharacters);
  }

  const summary = summarizeDropped(dropped);
  const note = { role: "system", pinned: true, content: summary };
  const kept = messages.filter((_, index) => keep.has(index));
  const insertAt = firstUser === -1 ? 0 : kept.indexOf(messages[firstUser]) + 1;
  const compacted = [...kept.slice(0, insertAt), note, ...kept.slice(insertAt)];

  const size = measure(compacted);
  if (size > maxCharacters) {
    // Recur on the tail: keeping fewer recent messages is the only lever left
    // that does not touch a pinned decision.
    if (keepRecent > 2) return compactConversation(messages, { maxCharacters, keepRecent: keepRecent - 2 });
    throw new ContextTooLargeError(size, maxCharacters);
  }
  return { messages: compacted, compacted: true, dropped: dropped.length, summary };
}

/**
 * An assistant message carrying `tool_calls` and the `tool` messages that
 * answer it are a unit: keeping one without the other produces a request the
 * server rejects. This widens the keep set until every retained half has its
 * partner.
 */
function closeToolCallPairs(messages, keep) {
  for (let pass = 0; pass < 2; pass += 1) {
    messages.forEach((message, index) => {
      if (!keep.has(index)) return;
      if (message.role === "tool") {
        for (let back = index - 1; back >= 0; back -= 1) {
          if (messages[back].role === "assistant" && (messages[back].tool_calls ?? []).length > 0) { keep.add(back); break; }
        }
      }
      if (message.role === "assistant" && (message.tool_calls ?? []).length > 0) {
        const ids = new Set(message.tool_calls.map((call) => call.id));
        for (let forward = index + 1; forward < messages.length; forward += 1) {
          if (messages[forward].role !== "tool") break;
          if (ids.has(messages[forward].tool_call_id)) keep.add(forward);
        }
      }
    });
  }
}

function summarizeDropped(dropped) {
  const tools = dropped.flatMap((message) => (message.tool_calls ?? []).map((call) => call.function?.name ?? call.name)).filter(Boolean);
  const counts = new Map();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  const toolLine = counts.size > 0
    ? `Tools used in that span: ${[...counts.entries()].map(([name, count]) => `${name}×${count}`).join(", ")}.`
    : "No tools were used in that span.";
  const roles = new Map();
  for (const message of dropped) roles.set(message.role, (roles.get(message.role) ?? 0) + 1);
  const roleLine = [...roles.entries()].map(([role, count]) => `${count} ${role}`).join(", ");
  return [
    `[Earlier conversation compacted to fit the context window.]`,
    `${dropped.length} messages were removed (${roleLine}).`,
    toolLine,
    `Decisions, approvals, task state, and the original objective were kept and appear elsewhere in this conversation. Do not assume anything about the removed messages beyond this summary; ask if you need it.`,
  ].join(" ");
}
