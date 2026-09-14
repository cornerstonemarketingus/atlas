import { sessionCookieHeader, signSession } from "../session.mjs";

function sameSecret(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ message: "Cross-origin operator sign-in is not allowed." }, { status: 403 });
  }
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
  if (!sameSecret(accessCode, expected)) {
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
