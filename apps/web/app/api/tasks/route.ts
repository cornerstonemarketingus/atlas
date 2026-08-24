import { randomUUID } from "node:crypto";
import { allowedRepositories, dispatchGitHub, validateTask } from "./dispatch.mjs";
import { createInstallationToken, githubAppConfiguration } from "./github-app.mjs";

export async function POST(request: Request) {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (!userId) return Response.json({ message: "Sign in is required to create a task." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const validated = validateTask(body, allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES));
  if ("error" in validated) return Response.json({ message: validated.error }, { status: validated.status });
  const task = validated.task;
  const taskId = randomUUID();
  let githubToken = process.env.ATLAS_GITHUB_TOKEN;
  try {
    const githubApp = githubAppConfiguration();
    if (githubApp.configured) githubToken = await createInstallationToken(githubApp);
  } catch {
    return Response.json({ message: "GitHub App authentication is temporarily unavailable." }, { status: 502 });
  }
  if (githubToken) {
    try {
      const response = await dispatchGitHub({ token: githubToken, workflow: process.env.ATLAS_GITHUB_WORKFLOW, task, taskId });
      if (!response.ok) return Response.json({ message: "GitHub Actions rejected the task dispatch." }, { status: 502 });
      return Response.json({ taskId, status: "dispatched", runner: "github-actions" }, { status: 202 });
    } catch {
      return Response.json({ message: "GitHub Actions is temporarily unavailable." }, { status: 502 });
    }
  }
  const endpoint = process.env.ATLAS_AGENT_DISPATCH_URL;
  const token = process.env.ATLAS_AGENT_DISPATCH_TOKEN;
  if (!endpoint || !token) return Response.json({ message: "The autonomous task dispatcher has not been configured." }, { status: 503 });
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ taskId, ...task, requestedBy: userId, commitMode: "approval-required" }) });
    if (!response.ok) return Response.json({ message: "The autonomous task dispatcher rejected the task." }, { status: 502 });
    return Response.json({ taskId, status: "dispatched", runner: "custom" }, { status: 202 });
  } catch {
    return Response.json({ message: "The autonomous task dispatcher is temporarily unavailable." }, { status: 502 });
  }
}
