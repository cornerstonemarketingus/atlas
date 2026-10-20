import { constantTimeEqual } from "../tasks/operator-auth.mjs";

/**
 * HTTP gateway to the inference governor for callers outside the Worker (the
 * coder CLI on a GitHub Actions runner, a local daemon), so their model calls
 * reserve against the same per-provider ledger that hosted chat uses.
 *
 * Authentication is its own narrow secret, ATLAS_GOVERNOR_TOKEN: it can reserve,
 * release, observe and withdraw capacity and read counts, and nothing else. It
 * is deliberately not the operator token, so a runner that holds it cannot act
 * as an operator. With no token configured the gateway is off (404).
 *
 * The scope names a provider quota (origin plus an optional one-way key digest,
 * see quotaScopeFor); only that shape is accepted so a caller cannot address
 * arbitrary Durable Object names. Reply bodies carry ledger decisions only.
 */
const METHODS = new Set(["reserve", "release", "observe", "withdraw", "snapshot"]);
const SCOPE = /^https:\/\/[a-z0-9.-]{1,120}(?::\d{1,5})?(?:#[0-9a-f]{16})?$/u;
const MAX_BODY_BYTES = 16 * 1024;

const refuse = (status, message) => Response.json({ message }, { status });

/** @param {(scope: string, method: string, argument: unknown) => Promise<unknown>} call returns null when the governor is unavailable */
export async function handleGovernorGateway(request, { environment, call }) {
  const token = environment?.ATLAS_GOVERNOR_TOKEN;
  if (!token) return refuse(404, "Not found.");
  if (request.method !== "POST") return refuse(405, "Method not allowed.");
  if (!constantTimeEqual(request.headers.get("authorization") ?? "", `Bearer ${token}`)) return refuse(401, "Authentication is required.");

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return refuse(413, "Request is too large.");
  let text;
  try { text = await request.text(); } catch { return refuse(400, "Request body could not be read."); }
  if (text.length > MAX_BODY_BYTES) return refuse(413, "Request is too large.");
  let body;
  try { body = JSON.parse(text); } catch { return refuse(400, "Request body must be valid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse(400, "Request body must be a JSON object.");

  const { method, scope, argument } = body;
  if (typeof method !== "string" || !METHODS.has(method)) return refuse(400, "Unknown governor method.");
  if (typeof scope !== "string" || !SCOPE.test(scope)) return refuse(400, "Invalid quota scope.");
  if (argument !== undefined && (argument === null || typeof argument !== "object" || Array.isArray(argument))) return refuse(400, "argument must be a JSON object.");

  const result = await call(scope, method, argument ?? {});
  if (result === null || result === undefined) return refuse(503, "The governor is unavailable.");
  return Response.json(result);
}
