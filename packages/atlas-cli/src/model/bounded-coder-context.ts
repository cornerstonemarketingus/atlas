import type { ModelMessage, ModelRequest } from "./model-provider.js";
import { resolveOfferedToolName } from "../agent/tool-name-resolution.js";

const REREADABLE = new Set(["repository.read_source", "repository.search", "repository.inspect", "repository.symbols", "repository.references", "repository.tests_for"]);
const OMITTED = "Read result omitted to fit the request budget. Read a smaller source range with startLine/endLine and maxBytes, or search with fewer maxResults. Do not reconstruct missing file contents from memory.";

/** Bound a request without altering objectives, edit arguments, errors, or tool pairing.
 * Bytes are a conservative sizing heuristic, not a vendor tokenizer or TPM guarantee.
 * The original messages remain intact for the audit trace.
 */
export function boundCoderContext(request: ModelRequest, maximumBytes: number): ModelRequest | undefined {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new RangeError("maximumBytes must be positive.");
  const messages: ModelMessage[] = [...request.messages];
  const result = { ...request, messages };
  const fits = () => Buffer.byteLength(JSON.stringify(result), "utf8") <= maximumBytes;
  if (fits()) return result;
  const offered = request.tools?.map(tool => tool.name) ?? [...REREADABLE];
  const pending = new Map<string, boolean>();
  // Oldest first: retain recent exact source whenever possible. A single huge
  // read is replaced explicitly, never silently presented as a complete file.
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      // Provider adapters can reuse IDs across turns. Only the immediately
      // preceding batch can authorize compaction of a result; duplicate IDs
      // inside that batch are ambiguous and must retain their full evidence.
      pending.clear();
      for (const part of message.content) {
        if (part.type !== "tool-call") continue;
        const canonical = request.tools === undefined ? part.name : resolveOfferedToolName(part.name, offered, offered);
        const readable = canonical !== undefined && REREADABLE.has(canonical);
        pending.set(part.id, pending.has(part.id) ? false : readable);
      }
      continue;
    }
    if (message.role !== "tool") {
      pending.clear();
      continue;
    }
    const readable = pending.get(message.toolCallId) === true;
    pending.delete(message.toolCallId);
    if (message.isError || !readable) continue;
    const replacement: ModelMessage = { ...message, content: [{ type: "text", text: OMITTED }] };
    if (Buffer.byteLength(JSON.stringify(replacement)) >= Buffer.byteLength(JSON.stringify(message))) continue;
    messages[index] = replacement;
    if (fits()) return result;
  }
  return undefined;
}
