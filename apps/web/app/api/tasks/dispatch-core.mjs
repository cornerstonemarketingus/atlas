import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { conversationMessages, conversations, repositories, runEvents, tasks } from "../../../db/schema";
import { checkAndRecordUsage } from "../billing/plan.mjs";
import { allowedRepositories, defaultMergePolicy, dispatchGitHub, validateTask, workflowForMode } from "./dispatch.mjs";
import { explainGitHubFailure } from "./github-diagnosis.mjs";
import { createInstallationToken, githubAppConfiguration } from "./github-app.mjs";
import { repositoryAccessDecision } from "./repository-access.mjs";
import { selfModificationDecision } from "./self-protection.mjs";

export async function dispatchTaskForAccount(account, body, correlationId, environment = process.env) {
  const validated = validateTask(body, allowedRepositories(environment.ATLAS_ALLOWED_REPOSITORIES));
  if ("error" in validated) return Response.json({ message: validated.error, ...(validated.needsClarification ? { needsClarification: true } : {}) }, { status: validated.status });
  const task = validated.task;
  const selfModification = selfModificationDecision(account, task);
  if (!selfModification.allowed) return Response.json({ message: selfModification.reason }, { status: selfModification.status });
  const requestedConversationId = typeof body?.conversationId === "string" ? body.conversationId : "";
  const conversationId = /^[0-9a-f-]{36}$/u.test(requestedConversationId) ? requestedConversationId : randomUUID();

  let githubToken = environment.ATLAS_GITHUB_TOKEN;
  try {
    const githubApp = githubAppConfiguration(environment);
    if (githubApp.configured) githubToken = await createInstallationToken(githubApp);
  } catch {
    return Response.json({ message: "GitHub App authentication failed, so nothing was started.", code: "GITHUB_APP_AUTH_FAILED", blocked: "BLOCKED_BY_MISSING_CREDENTIAL", unblock: "Check the ATLAS_GITHUB_APP_* secrets (app id, installation id, private key) and redeploy." }, { status: 502 });
  }
  if (githubToken) {
    const access = await repositoryAccessDecision(account, task, { token: githubToken });
    if (!access.allowed) return Response.json({ message: access.message, code: access.code, blocked: access.blocked, unblock: access.unblock }, { status: access.status });
  }

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
    mergePolicy = defaultMergePolicy(environment.ATLAS_DEFAULT_MERGE_POLICY);
    try {
      const [owner, name] = task.repository.split("/");
      const [row] = await getDb().select().from(repositories).where(and(eq(repositories.owner, owner), eq(repositories.name, name)));
      if (row) mergePolicy = row.mergePolicy;
    } catch {
      // Ignore settings lookup failures and keep the default.
    }
  }

  const taskId = randomUUID();
  if (githubToken) {
    try {
      const workflow = workflowForMode(task.mode, { defaultWorkflow: environment.ATLAS_GITHUB_WORKFLOW, coderWorkflow: environment.ATLAS_CODER_WORKFLOW });
      const response = await dispatchGitHub({ token: githubToken, workflow, task, taskId, mergePolicy, correlationId });
      if (!response.ok) {
        const failure = explainGitHubFailure(response.status, { workflow, repository: task.repository });
        return Response.json({ ...failure, message: `${failure.message} Nothing was started.` }, { status: 502 });
      }
      const recorded = await recordDispatchedTask(account, task, taskId, mergePolicy, conversationId, "managed", correlationId);
      return Response.json({ taskId, conversationId, correlationId, status: "dispatched", runner: "managed", recorded, mergePolicy }, { status: 202 });
    } catch {
      return Response.json({ ...explainGitHubFailure(503), message: "GitHub could not be reached, so nothing was started." }, { status: 502 });
    }
  }

  const endpoint = environment.ATLAS_AGENT_DISPATCH_URL;
  const token = environment.ATLAS_AGENT_DISPATCH_TOKEN;
  if (!endpoint || !token) return Response.json({ message: "The autonomous task dispatcher has not been configured." }, { status: 503 });
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: ["Bearer", token].join(" "), "content-type": "application/json" },
      body: JSON.stringify({ taskId, ...task, requestedBy: account.userId, commitMode: "approval-required" }),
    });
    if (!response.ok) return Response.json({ message: "The autonomous task dispatcher rejected the task." }, { status: 502 });
    const recorded = await recordDispatchedTask(account, task, taskId, mergePolicy, conversationId, "private", correlationId);
    return Response.json({ taskId, conversationId, correlationId, status: "dispatched", runner: "private", recorded, mergePolicy }, { status: 202 });
  } catch {
    return Response.json({ message: "The autonomous task dispatcher is temporarily unavailable." }, { status: 502 });
  }
}

async function recordDispatchedTask(account, task, taskId, mergePolicy, conversationId, executionProvider, correlationId) {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(conversations).values({ id: conversationId, requestedBy: account.userId, title: task.objective.slice(0, 72), repository: task.repository, branch: task.branch, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: conversations.id, set: { updatedAt: now, repository: task.repository, branch: task.branch } });
    await db.insert(conversationMessages).values({ id: randomUUID(), conversationId, requestedBy: account.userId, role: "user", content: task.objective, createdAt: now });
    await db.insert(runEvents).values({ id: randomUUID(), conversationId, taskId, requestedBy: account.userId, kind: "queued", label: "Request received", detail: "Atlas is preparing a private execution workspace.", createdAt: now });
    await db.insert(tasks).values({
      taskId,
      userId: account.dbUserId,
      requestedBy: account.userId,
      repository: task.repository,
      branch: task.branch,
      mode: task.mode,
      objective: task.objective,
      mergePolicy,
      conversationId,
      executionProvider,
      correlationId,
      createdAt: now,
    });
    return true;
  } catch {
    return false;
  }
}
