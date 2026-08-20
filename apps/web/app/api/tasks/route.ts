import { randomUUID } from "node:crypto";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^(?!\/|.*(?:\.\.|\/\/|@\{|\\|\s|[\x5b~^:?*]))[A-Za-z0-9._/-]{1,255}$/;
const modes = new Set(["inspect", "plan", "implement", "review"]);

function allowedRepositories() {
  return new Set((process.env.ATLAS_ALLOWED_REPOSITORIES ?? "cornerstonemarketingus/atlas")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export async function POST(request: Request) {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (!userId) return Response.json({ message: "Sign in is required to create a task." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object") return Response.json({ message: "A task payload is required." }, { status: 400 });
  const { repository, branch, mode, objective } = body as Record<string, unknown>;
  if (typeof repository !== "string" || !repositoryPattern.test(repository) || !allowedRepositories().has(repository.toLowerCase())) return Response.json({ message: "That repository is not on your Atlas allowlist." }, { status: 403 });
  if (typeof branch !== "string" || !branchPattern.test(branch)) return Response.json({ message: "Branch name is invalid." }, { status: 400 });
  if (typeof mode !== "string" || !modes.has(mode)) return Response.json({ message: "Task mode is invalid." }, { status: 400 });
  if (typeof objective !== "string" || !objective.trim() || objective.length > 4_000) return Response.json({ message: "Objective is invalid." }, { status: 400 });
  const endpoint = process.env.ATLAS_AGENT_DISPATCH_URL;
  const token = process.env.ATLAS_AGENT_DISPATCH_TOKEN;
  if (!endpoint || !token) return Response.json({ message: "The autonomous task dispatcher has not been configured." }, { status: 503 });
  const taskId = randomUUID();
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ taskId, repository, branch, mode, objective: objective.trim(), requestedBy: userId, commitMode: "approval-required" }) });
  if (!response.ok) return Response.json({ message: "The autonomous task dispatcher rejected the task." }, { status: 502 });
  return Response.json({ taskId, status: "awaiting-approval" }, { status: 202 });
}
