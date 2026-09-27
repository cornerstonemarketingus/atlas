/**
 * The messages sent to the model for one chat reply, ordered for the
 * provider's prompt cache (Groq, OpenAI and vLLM reuse only a byte-identical
 * prefix, and cached tokens do not count against Groq's rate limits).
 *
 * Stable parts first: the system prompt, then the conversation so far. The
 * memory digest (recall from other conversations and recent runs) changes
 * from turn to turn, so it goes after the history, just before the new
 * message; placed first, it made every turn a cache miss for the whole
 * history (docs/PROGRAM.md 1.4, prompt fingerprints in #133).
 *
 * Earlier conversations are data the person wrote (or Atlas replied), never
 * instructions; the block cannot be closed from inside.
 *
 * @param {{ system: string, history?: { role: string, content: string }[], memory?: string, message: string, historyTurns?: number }} input
 * @returns {{ role: string, content: string }[]}
 */
export function chatTurns({ system, history = [], memory = "", message, historyTurns = 20 }) {
  return [
    { role: "system", content: system },
    ...history.slice(-historyTurns).map((turn) => ({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.content })),
    ...(memory ? [{ role: "system", content: `<data source="earlier conversations and recent runs in this workspace">\n${memory.replace(/<(\s*\/?\s*)data\b/giu, "&lt;$1data")}\n</data>` }] : []),
    { role: "user", content: message },
  ];
}
