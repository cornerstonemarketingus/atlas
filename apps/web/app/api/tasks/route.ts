import { randomUUID } from "node:crypto";
export async function POST(request: Request) {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (!userId) return Response.json({ message: "Sign in is required to create a task." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object") return Response.json({ message: "A task payload is required." }, { status: 400 });
  const { repository, objective } = body as Record<string, unknown>;
  if (repository !== "cornerstonemarketingus/atlas" || typeof objective !== "string" || !objective.trim() || objective.length > 4_000) return Response.json({ message: "Repository or objective is invalid." }, { status: 400 });
  const endpoint = process.env.ATLAS_AGENT_DISPATCH_URL;
  const token = process.env.ATLAS_AGENT_DISPATCH_TOKEN;
  if (!endpoint || !token) return Response.json({ message: "The autonomous task dispatcher has not been configured." }, { status: 503 });
  const taskId = randomUUID();
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ taskId, repository, objective: objective.trim(), requestedBy: userId, commitMode: "approval-required" }) });
  if (!response.ok) return Response.json({ message: "The autonomous task dispatcher rejected the task." }, { status: 502 });
  return Response.json({ taskId, status: "awaiting-approval" }, { status: 202 });
}
