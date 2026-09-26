import { runAutomations } from "../../automations/runner";

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function verifyGithubSignature(body: string, signature: string | null, secret: string | undefined) {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = new TextEncoder().encode(`sha256=${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`);
  const actual = new TextEncoder().encode(signature);
  return timingSafeEqual(expected, actual);
}

function githubFailureEvent(eventName: string | null, payload: Record<string, unknown>, deliveryId: string | null) {
  const repository = typeof (payload.repository as { full_name?: unknown } | undefined)?.full_name === "string"
    ? (payload.repository as { full_name: string }).full_name.toLowerCase()
    : null;
  if (!repository) return null;
  if (eventName === "check_run") {
    const checkRun = payload.check_run as { conclusion?: unknown; status?: unknown; check_suite?: { head_branch?: unknown }; name?: unknown } | undefined;
    if (!checkRun || checkRun.status !== "completed" || checkRun.conclusion !== "failure") return null;
    const branch = typeof checkRun.check_suite?.head_branch === "string" ? checkRun.check_suite.head_branch : "";
    if (!branch) return null;
    return { kind: "github.check-failed" as const, repository, branch, checkName: typeof checkRun.name === "string" ? checkRun.name : "", deliveryId };
  }
  if (eventName === "workflow_run") {
    const run = payload.workflow_run as { conclusion?: unknown; event?: unknown; head_branch?: unknown; name?: unknown } | undefined;
    if (!run || run.conclusion !== "failure") return null;
    const branch = typeof run.head_branch === "string" ? run.head_branch : "";
    if (!branch) return null;
    return { kind: "github.check-failed" as const, repository, branch, checkName: typeof run.name === "string" ? run.name : "", deliveryId };
  }
  return null;
}

export async function POST(request: Request) {
  const raw = await request.text();
  const valid = await verifyGithubSignature(
    raw,
    request.headers.get("x-hub-signature-256"),
    process.env.ATLAS_GITHUB_WEBHOOK_SECRET,
  );
  if (!valid) return Response.json({ message: "GitHub webhook signature is invalid." }, { status: 401 });
  const eventName = request.headers.get("x-github-event");
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { return Response.json({ message: "Webhook payload is invalid JSON." }, { status: 400 }); }
  const event = githubFailureEvent(eventName, payload, request.headers.get("x-github-delivery"));
  if (!event) return Response.json({ accepted: true, started: 0 });
  const runs = await runAutomations(event);
  return Response.json({ accepted: true, started: runs.filter((run) => run.status === "started").length, runs });
}
