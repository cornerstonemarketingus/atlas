import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../db";
import { computerApprovals, computerDevices, computerTasks } from "../../../../db/schema";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";
import { currentPlan } from "../../billing/plan.mjs";
import { cloudBrowserAccess } from "../browser-plan.mjs";

async function capabilities(account: { userId: string; dbUserId: number | null }) {
  const unrestricted = account.dbUserId === null;
  const tier = unrestricted ? "operator" : (await currentPlan(getDb(), account.dbUserId)).tier;
  const cloudflare = cloudBrowserAccess(tier, process.env.ATLAS_CLOUDFLARE_BROWSER_ENABLED === "true", unrestricted);
  return {
    defaultProvider: "windows",
    providers: {
      windows: { available: true, included: true, label: "My Windows PC" },
      cloudflare: { ...cloudflare, label: "Cloudflare hosted browser" },
    },
  };
}

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const db = getDb();
  const [tasks, approvals] = await Promise.all([
    db.select().from(computerTasks).where(eq(computerTasks.requestedBy, account.userId)).orderBy(desc(computerTasks.createdAt)).limit(20),
    db.select().from(computerApprovals).where(and(eq(computerApprovals.requestedBy, account.userId), eq(computerApprovals.status, "pending"), isNull(computerApprovals.decidedAt))).orderBy(desc(computerApprovals.createdAt)),
  ]);
  return Response.json({ tasks, approvals, capabilities: await capabilities(account) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: { deviceId?: unknown; objective?: unknown; startUrl?: unknown; executionProvider?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  let deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  const executionProvider = body.executionProvider === "cloudflare" ? "cloudflare" : "windows";
  const objective = typeof body.objective === "string" ? body.objective.trim().slice(0, 2000) : "";
  let startUrl: string | null = null;
  if (typeof body.startUrl === "string" && body.startUrl.trim()) {
    try { const parsed = new URL(body.startUrl.trim()); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); startUrl = parsed.toString(); }
    catch { return Response.json({ message: "Start URL must be an http or https address." }, { status: 400 }); }
  }
  if (!objective || (executionProvider === "windows" && !deviceId)) return Response.json({ message: "Choose a computer and describe the browser task." }, { status: 400 });
  const db = getDb();
  if (executionProvider === "cloudflare") {
    const access = (await capabilities(account)).providers.cloudflare;
    if (!access.entitled) return Response.json({ message: "Cloudflare hosted browsing requires a Pro or Team plan." }, { status: 402 });
    if (!access.configured) return Response.json({ message: "Hosted browsing is included with your plan but is not active on this Atlas deployment yet." }, { status: 503 });
    deviceId = `cloudflare-${createHash("sha256").update(account.userId).digest("hex").slice(0, 24)}`;
    await db.insert(computerDevices).values({ id: deviceId, requestedBy: account.userId, name: "Cloudflare Browser", platform: "cloudflare", status: "online", secretHash: createHash("sha256").update(randomBytes(32)).digest("hex") }).onConflictDoNothing();
  }
  const [device] = await db.select().from(computerDevices).where(and(eq(computerDevices.id, deviceId), eq(computerDevices.requestedBy, account.userId), isNull(computerDevices.revokedAt))).limit(1);
  if (!device || device.platform !== executionProvider) return Response.json({ message: "That execution provider is not available." }, { status: 404 });
  const id = randomUUID();
  await db.insert(computerTasks).values({ id, requestedBy: account.userId, deviceId, executionProvider, objective, startUrl });
  return Response.json({ task: { id, status: "queued" } }, { status: 201 });
}
