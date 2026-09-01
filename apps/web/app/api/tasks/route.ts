import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../../db";
import { repositories } from "../../../db/schema";
import { checkAndRecordUsage } from "../billing/plan.mjs";
import { allowedRepositories, dispatchGitHub, validateTask, workflowForMode } from "./dispatch.mjs";
import { createInstallationToken, githubAppConfiguration } from "./github-app.mjs";
import { authenticatedAccount } from "./operator-auth.mjs";

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required to create a task." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const validated = validateTask(body, allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES));
  if ("error" in validated) return Response.json({ message: validated.error }, { status: validated.status });
  const task = validated.task;

  // Platform-header and operator-token requests aren't billed GitHub accounts
  // (see operator-auth.mjs) — they bypass plan gating entirely rather than
  // being guessed into a tier.
  if (account.dbUserId !== null) {
    try {
      const usage = await checkAndRecordUsage(getDb(), account.dbUserId, task.mode);
      if (!usage.allowed) return Response.json({ message: usage.reason }, { status: 402 });
    } catch (error) {
      return Response.json({ message: error instanceof Error ? error.message : "Could not verify your plan." }, { status: 500 });
    }
  }

  let mergePolicy = "manual";
  if (task.mode === "coder") {
    try {
      const [owner, name] = task.repository.split("/");
      const [row] = await getDb().select().from(repositories).where(and(eq(repositories.owner, owner), eq(repositories.name, name)));
      if (row) mergePolicy = row.mergePolicy;
    } catch {
      // Falls back to the safe "manual" default — a settings-lookup failure
      // should never accidentally widen how a PR gets merged.
    }
  }

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
      const workflow = workflowForMode(task.mode, { defaultWorkflow: process.env.ATLAS_GITHUB_WORKFLOW, coderWorkflow: process.env.ATLAS_CODER_WORKFLOW });
      const response = await dispatchGitHub({ token: githubToken, workflow, task, taskId, mergePolicy });
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
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ taskId, ...task, requestedBy: account.userId, commitMode: "approval-required" }) });
    if (!response.ok) return Response.json({ message: "The autonomous task dispatcher rejected the task." }, { status: 502 });
    return Response.json({ taskId, status: "dispatched", runner: "custom" }, { status: 202 });
  } catch {
    return Response.json({ message: "The autonomous task dispatcher is temporarily unavailable." }, { status: 502 });
  }
}
