/**
 * Structured tool-call validation — the gate between "the model said" and
 * "Atlas executes". Model output is untrusted text: it may be fenced, truncated,
 * name a tool that does not exist, or carry arguments that do not match the
 * schema. Nothing reaches a tool until it parses and validates here.
 */
import { validateSchema } from "../../../../../packages/atlas-contracts/src/index.mjs";

export const MAX_TOOL_CALL_CHARS = 262_144;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * @param modelOutput a JSON string (optionally ```json fenced), or an object in
 *   one of the common shapes: `{ name, arguments }`, `{ tool, input }`,
 *   `{ function: { name, arguments } }` (OpenAI), `{ type: "tool_use", name, input }`
 *   (Anthropic). `arguments` may itself be a JSON string.
 * @param toolSchema `{ name, parameters | inputSchema }`, or an array of them.
 * @returns `{ ok: true, call: { name, arguments, id? } }` or `{ ok: false, errors: [{ path, message }] }`.
 */
export function validateToolCall(modelOutput, toolSchema) {
  const tools = (Array.isArray(toolSchema) ? toolSchema : [toolSchema]).filter(Boolean);
  if (tools.length === 0) return fail("$", "No tool schema was supplied to validate against.");

  let raw = modelOutput;
  if (typeof raw === "string") {
    if (raw.length > MAX_TOOL_CALL_CHARS) return fail("$", `The tool call is larger than ${MAX_TOOL_CALL_CHARS} characters.`);
    const parsed = parseJson(raw);
    if (!parsed.ok) return fail("$", `The tool call is not valid JSON: ${parsed.error}`);
    raw = parsed.value;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("$", "A tool call must be a JSON object.");

  const fn = raw.function && typeof raw.function === "object" ? raw.function : raw;
  const name = fn.name ?? raw.tool ?? raw.tool_name;
  if (typeof name !== "string" || name === "") return fail("$.name", "The tool call does not name a tool.");
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return fail("$.name", `Unknown tool '${name}'. Expected one of: ${tools.map((candidate) => candidate.name).join(", ")}.`);

  let args = fn.arguments ?? fn.input ?? raw.arguments ?? raw.input ?? raw.parameters ?? {};
  if (typeof args === "string") {
    if (args.trim() === "") args = {};
    else {
      const parsed = parseJson(args);
      if (!parsed.ok) return fail("$.arguments", `The arguments are not valid JSON: ${parsed.error}`);
      args = parsed.value;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return fail("$.arguments", "Tool arguments must be a JSON object.");
  const forbidden = findForbiddenKey(args, "$.arguments");
  if (forbidden) return fail(forbidden, "Reserved object key is not allowed in tool arguments.");

  const schema = tool.parameters ?? tool.inputSchema ?? tool.input_schema ?? { type: "object" };
  const errors = validateSchema(schema, args, "$.arguments");
  if (errors.length > 0) return { ok: false, errors };
  const call = { name, arguments: args };
  const id = raw.id ?? raw.toolCallId;
  if (typeof id === "string") call.id = id;
  return { ok: true, call };
}

function parseJson(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try { return { ok: true, value: JSON.parse(stripped) }; }
  catch (error) { return { ok: false, error: error.message }; }
}

function findForbiddenKey(value, path) {
  if (!value || typeof value !== "object") return null;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return `${path}.${key}`;
    const nested = findForbiddenKey(value[key], `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
}

function fail(path, message) {
  return { ok: false, errors: [{ path, message }] };
}
