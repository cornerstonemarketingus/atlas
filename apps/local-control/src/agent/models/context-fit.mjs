import { compactConversation, ContextTooLargeError, measure } from "../compaction.mjs";

const CHARACTERS_PER_TOKEN = 3.6;

export function estimateTokens(characters) {
  return Math.ceil(Math.max(0, characters) / CHARACTERS_PER_TOKEN);
}

export function usableContextCharacters({ contextWindow, maxOutputTokens = 2_048, reservedCharacters = 0 }) {
  const inputTokens = Math.max(0, contextWindow - maxOutputTokens);
  return Math.floor(inputTokens * CHARACTERS_PER_TOKEN) - Math.max(0, reservedCharacters);
}

export function fitToContext(messages, options) {
  const availableCharacters = usableContextCharacters(options);
  if (availableCharacters <= 0) throw tokenError(measure(messages) + (options.reservedCharacters ?? 0), Math.max(0, availableCharacters));
  if (measure(messages) <= availableCharacters) return { messages, compacted: false, dropped: 0, note: null };
  try {
    const result = compactConversation(messages, { maxCharacters: availableCharacters });
    return { ...result, note: `The earlier messages were summarized to fit the context window. ${result.summary}` };
  } catch (error) {
    if (!(error instanceof ContextTooLargeError)) throw error;
    throw tokenError(error.required + (options.reservedCharacters ?? 0), Math.max(0, availableCharacters + (options.reservedCharacters ?? 0)));
  }
}

function tokenError(requiredCharacters, availableCharacters) {
  return new ContextTooLargeError(estimateTokens(requiredCharacters), estimateTokens(availableCharacters), "tokens");
}

export function describeContextFailure(error, route) {
  const assumption = route.contextSource === "assumed" ? " This model's context window is assumed, not reported by the server." : "";
  return `The request needs ${error.required.toLocaleString("en-US")} tokens, but ${route.model} can accept only ${error.available.toLocaleString("en-US")}. Nothing was sent.${assumption}`;
}
