import type { ModelMessage, ModelRequest } from "./model-provider.js";

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
  const readIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && REREADABLE.has(part.name)) readIds.add(part.id);
    }
  }
  // Oldest first: retain recent exact source whenever possible. A single huge
  // read is replaced explicitly, never silently presented as a complete file.
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "tool" || message.isError || !readIds.has(message.toolCallId)) continue;
    const replacement: ModelMessage = { ...message, content: [{ type: "text", text: OMITTED }] };
    if (Buffer.byteLength(JSON.stringify(replacement)) >= Buffer.byteLength(JSON.stringify(message))) continue;
    messages[index] = replacement;
    if (fits()) return result;
  }
  return undefined;
}
