import { getD1 } from "../../../../db";
import { authenticatedAccount } from "../operator-auth.mjs";
import { resolveTenantContext, tenantScope, NO_TENANT_MESSAGE, TENANT_HEADER } from "../../auth/tenant-context.mjs";
import { POST as dispatchTask } from "../route";
import { TASK_REQUEST_KEY, taskRequestFingerprint } from "../task-request-contract.mjs";
import { executeTaskRequest } from "../task-requests.mjs";
import { CORRELATION_HEADER } from "../correlation.mjs";
import { requestInspectionResponse } from "../request-inspection-route.mjs";

export async function GET(request: Request) {
  return requestInspectionResponse(request);
}

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required to create a task." }, { status: 401 });
  const key = request.headers.get("idempotency-key") ?? "";
  if (!TASK_REQUEST_KEY.test(key)) return Response.json({ message: "A UUID request key is required." }, { status: 400 });
  let payload: Record<string, unknown>;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing body");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 65536) return Response.json({ message: "Request is too large." }, { status: 413 });
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid request");
  } catch { return Response.json({ message: "Request body must be a JSON object." }, { status: 400 }); }
  let fingerprint: string;
  try { fingerprint = await taskRequestFingerprint(payload); }
  catch { return Response.json({ message: "Request nesting is too deep." }, { status: 400 }); }
  try {
    const d1 = getD1();
    const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    return await executeTaskRequest(d1, tenantScope(tenant), { key: key.toLowerCase(), fingerprint }, (correlationId: string) => {
      const headers = new Headers(request.headers);
      headers.set(CORRELATION_HEADER, correlationId);
      headers.set(TENANT_HEADER, String(tenant.tenantId));
      return dispatchTask(new Request(new URL("/api/tasks", request.url), { method: "POST", headers, body: JSON.stringify(payload) }));
    });
  } catch { return Response.json({ message: "Saved request storage is unavailable. Retry when it is available." }, { status: 503 }); }
}
