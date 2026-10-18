export const TASK_REQUEST_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function ordered(value, depth = 0) {
  if (depth > 20) throw new Error("Request nesting is too deep");
  if (Array.isArray(value)) return value.map(item => ordered(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key], depth + 1)]));
  return value;
}

export async function taskRequestFingerprint(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(ordered(payload)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
