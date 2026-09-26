import { getDb } from "../../../../db";
import { requestRateLimits } from "../../../../db/schema";
import { sessionCookieHeader, signSession } from "../session.mjs";
import { constantTimeEqual } from "../../tasks/operator-auth.mjs";
import { enforceRateLimit, rateLimitSubjectForIp } from "../../rate-limit.mjs";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ message: "Cross-origin operator sign-in is not allowed." }, { status: 403 });
  }
  const limited = await enforceRateLimit({
    db: getDb,
    table: requestRateLimits,
    request,
    subject: rateLimitSubjectForIp(request),
    route: "auth_operator",
    limit: 5,
    windowSeconds: 15 * 60,
    failClosed: true,
  });
  if (limited) return limited;
  const expected = process.env.ATLAS_OPERATOR_TOKEN ?? "";
  const sessionSecret = process.env.ATLAS_SESSION_SECRET ?? "";
  if (!expected || !sessionSecret) {
    return Response.json({ message: "Operator access is not configured." }, { status: 503 });
  }

  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const accessCode = body && typeof body === "object" && "accessCode" in body
    ? String((body as { accessCode?: unknown }).accessCode ?? "")
    : "";
  // Digest-then-compare: the old length check returned early and leaked the
  // access code's length through timing.
  if (!(await constantTimeEqual(accessCode, expected))) {
    return Response.json({ message: "That access code is not valid." }, { status: 401 });
  }

  const operatorSessionSeconds = 60 * 60;
  const token = await signSession({ role: "operator" }, sessionSecret, Date.now(), operatorSessionSeconds);
  return Response.json({ signedIn: true }, {
    headers: {
      "cache-control": "no-store",
      "set-cookie": sessionCookieHeader(token, operatorSessionSeconds),
    },
  });
}
