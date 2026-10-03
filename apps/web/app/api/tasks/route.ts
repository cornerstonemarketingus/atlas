import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { getD1, getDb } from "../../../db";
import { conversationWritable, tenantAllowlist } from "../../../db/tenancy.mjs";
import { NO_TENANT_MESSAGE, resolveTenantContext, tenantScope } from "../auth/tenant-context.mjs";
import { conversationMessages, conversations, repositories, runEvents, tasks } from "../../../db/schema";
import { checkAndRecordUsage } from "../billing/plan.mjs";
import { allowedRepositories, defaultMergePolicy, dispatchGitHub, validateTask, workflowForMode } from "./dispatch.mjs";
import { credentialKind, explainDispatchFailure, explainGitHubAppFailure, explainGitHubFailure } from "./github-diagnosis.mjs";
import { createInstallationToken, githubAppConfiguration } from "./github-app.mjs";
import {
  fetchGitHubJson,
  normalizePullRequest,
  normalizeRun,
  pullRequestForBranchRequest,
  workflowRunRequest,
  workflowRunsRequest,
} from "./github-runs.mjs";
import { authenticatedAccount } from "./operator-auth.mjs";
import { CORRELATION_HEADER, correlationIdFromRequest } from "./correlation.mjs";
import { assignRunsToTasks, coderBranchForTask, runUrl, taskStatusFromRun, visibleTasks } from "./run-status.mjs";
import { selfModificationDecision } from "./self-protection.mjs";
import { repositoryAccessDecision } from "./repository-access.mjs";
import { platformGitHubToken } from "./github-token.mjs";
import { taskStorageReadiness } from "./storage-readiness.mjs";

export async function POST(request: Request) {
  // A caller-supplied x-atlas-correlation-id is honoured only when it is
  // exactly the `cor_<32 hex>` shape; anything else is replaced. Every response
  // from this handler carries the id back in the same header.
  const correlationId = correlationIdFromRequest(request);
  const response = await dispatchTask(request, correlationId);
  const headers = new Headers(response.headers);
  headers.set(CORRELATION_HEADER, correlationId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function dispatchTask(request: Request, correlationId: string): Promise<Response> {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required to create a task." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  // Tenancy (#71): the caller's tenant bounds which repositories they may use
  // (its allowlist within ATLAS_ALLOWED_REPOSITORIES) and owns what is recorded.
  let tenant: { tenantId: number; role: string; principal: string } | null;
  let allowlist: Set<string>;
  try {
    tenant = await resolveTenantContext(request, account, getD1());
    allowlist = tenant ? await tenantAllowlist(getD1(), tenant.tenantId, allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES)) : new Set();
  } catch {
    return Response.json({ message: "Your workspace is unavailable. Apply D1 migration 0015_tenants." }, { status: 503 });
  }
  if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
  const validated = validateTask(body, allowlist);
  if ("error" in validated) return Response.json({ message: validated.error, ...(validated.needsClarification ? { needsClarification: true } : {}) }, { status: validated.status });
  const task = validated.task;
  const selfModification = selfModificationDecision(account, task);
  if (!selfModification.allowed) return Response.json({ message: selfModification.reason }, { status: selfModification.status });
  const storage = await taskStorageReadiness(getD1());
  if (!storage.ready) return Response.json({ ...storage, message: `${storage.message} Nothing was started.` }, { status: 503 });
  const requestedConversationId = typeof (body as { conversationId?: unknown }).conversationId === "string" ? (body as { conversationId: string }).conversationId : "";
  let conversationId = /^[0-9a-f-]{36}$/u.test(requestedConversationId) ? requestedConversationId : randomUUID();
  // Never append to a conversation owned by another tenant or principal.
  try { if (!(await conversationWritable(getD1(), tenantScope(tenant), conversationId))) conversationId = randomUUID(); } catch { conversationId = randomUUID(); }

  let githubToken = platformGitHubToken();
  let credential = credentialKind(githubToken);
  try {
    const githubApp = githubAppConfiguration();
    if (githubApp.configured) {
      githubToken = await createInstallationToken(githubApp);
      credential = credentialKind(githubToken, { githubApp: true });
    }
  } catch (error) {
    const failure = explainGitHubAppFailure(error, { repository: task.repository });
    return Response.json({ ...failure, message: `${failure.message} Nothing was started.` }, { status: 502 });
  }
  // The platform credential acts only on repositories this person could
  // work on themselves (SEC-1). Checked before plan usage is recorded, so a
  // refused request costs nothing.
  if (githubToken) {
    const access = await repositoryAccessDecision(account, task, { token: githubToken });
    if (!access.allowed) return Response.json({ message: access.message, code: access.code, blocked: access.blocked, unblock: access.unblock }, { status: access.status });
  }

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
    // A repository with no saved setting uses the deployment default. The
    // owner chose autopilot, so unless ATLAS_DEFAULT_MERGE_POLICY says
    // otherwise Atlas merges its own change once every CI check passes.
    mergePolicy = defaultMergePolicy(process.env.ATLAS_DEFAULT_MERGE_POLICY);
    try {
      const [owner, name] = task.repository.split("/");
      const [row] = await getDb().select().from(repositories).where(and(eq(repositories.tenantId, tenant.tenantId), eq(repositories.owner, owner), eq(repositories.name, name)));
      if (row) mergePolicy = row.mergePolicy;
    } catch {
      // A settings-lookup failure keeps the deployment default rather than
      // guessing: it never widens past what the operator configured.
    }
  }

  const taskId = randomUUID();
  if (githubToken) {
    try {
      const workflow = workflowForMode(task.mode, { defaultWorkflow: process.env.ATLAS_GITHUB_WORKFLOW, coderWorkflow: process.env.ATLAS_CODER_WORKFLOW });
      const response = await dispatchGitHub({ token: githubToken, workflow, task, taskId, mergePolicy, correlationId });
      if (!response.ok) {
        const failure = explainDispatchFailure(response, { workflow, repository: task.repository, credential });
        return Response.json({ ...failure, message: `${failure.message} Nothing was started.` }, { status: 502 });
      }
      const recorded = await recordDispatchedTask(account, tenant.tenantId, task, taskId, mergePolicy, conversationId, "managed", correlationId);
      return Response.json({ taskId, conversationId, correlationId, status: "dispatched", runner: "managed", recorded, mergePolicy }, { status: 202 });
    } catch {
      return Response.json({ ...explainGitHubFailure(503), message: "GitHub could not be reached, so nothing was started." }, { status: 502 });
    }
  }
  const endpoint = process.env.ATLAS_AGENT_DISPATCH_URL;
  const token = process.env.ATLAS_AGENT_DISPATCH_TOKEN;
  if (!endpoint || !token) return Response.json({ message: "The autonomous task dispatcher has not been configured." }, { status: 503 });
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", [CORRELATION_HEADER]: correlationId }, body: JSON.stringify({ taskId, ...task, requestedBy: account.userId, commitMode: "approval-required" }) });
    if (!response.ok) return Response.json({ message: "The autonomous task dispatcher rejected the task." }, { status: 502 });
    // Not recorded on purpose: the custom dispatcher produces no GitHub Actions
    // run, so a row for it could only ever be matched against — and could steal
    // the run id of — a real Actions dispatch of the same workflow. Custom-runner
    // deployments get no task history until they report runs of their own.
    const recorded = await recordDispatchedTask(account, tenant.tenantId, task, taskId, mergePolicy, conversationId, "private", correlationId);
    return Response.json({ taskId, conversationId, correlationId, status: "dispatched", runner: "private", recorded, mergePolicy }, { status: 202 });
  } catch {
    return Response.json({ message: "The autonomous task dispatcher is temporarily unavailable." }, { status: 502 });
  }
}

/**
 * Best-effort by design. GitHub has already accepted the dispatch and the user
 * has already been charged a task against their plan by this point, so a D1
 * problem must degrade to "dispatched, but not recorded" rather than reporting
 * failure for a task that is genuinely running. Same posture as the
 * merge-policy lookup above.
 */
async function recordDispatchedTask(
  account: { userId: string; dbUserId: number | null },
  tenantId: number,
  task: { repository: string; branch: string; mode: string; objective: string },
  taskId: string,
  mergePolicy: string,
  conversationId: string,
  executionProvider: string,
  correlationId: string,
): Promise<boolean> {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    await db.insert(conversations).values({ id: conversationId, tenantId, requestedBy: account.userId, title: task.objective.slice(0, 72), repository: task.repository, branch: task.branch, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: conversations.id, set: { updatedAt: now, repository: task.repository, branch: task.branch }, setWhere: and(eq(conversations.tenantId, tenantId), eq(conversations.requestedBy, account.userId)) });
    await db.insert(conversationMessages).values({ id: randomUUID(), conversationId, requestedBy: account.userId, role: "user", content: task.objective, createdAt: now });
    await db.insert(runEvents).values({ id: randomUUID(), conversationId, taskId, requestedBy: account.userId, kind: "queued", label: "Request received", detail: "Atlas is preparing a private execution workspace.", createdAt: now });
    await db.insert(tasks).values({
      taskId,
      tenantId,
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
      // Written explicitly rather than left to CURRENT_TIMESTAMP so the run-id
      // heuristic has an unambiguous, zone-marked dispatch time to match on.
      createdAt: now,
    });
    return true;
  } catch {
    return false;
  }
}

const TASK_PAGE_SIZE = 10;
const MAX_RUN_LISTINGS = 4;
const MAX_RUN_LOOKUPS = 10;
const MAX_PULL_REQUEST_LOOKUPS = 5;

type TaskRow = typeof tasks.$inferSelect;
type Run = NonNullable<ReturnType<typeof normalizeRun>>;
type PullRequest = NonNullable<ReturnType<typeof normalizePullRequest>>;

/**
 * Lists the caller's recent tasks and enriches them with live GitHub Actions
 * state.
 *
 * TENANT ISOLATION. Rows are filtered on `tasks.requested_by`, which is the
 * principal string `authenticatedAccount()` returns, NOT on the nullable
 * `users.id`. That matters specifically for the two auth paths where
 * `dbUserId === null`:
 *   - the platform header (`oai-authenticated-user-id`) identifies a distinct
 *     ChatGPT user per request — these are separate customers, and bucketing
 *     them by a null `userId` would show each of them all the others' task
 *     objectives, which describe their source-code intent;
 *   - the operator token is a single deployment-wide credential, so every
 *     holder of it is the same principal ("operator") and sees only tasks
 *     dispatched with that token.
 * A GitHub-session user is "github:<login>". No principal string can collide
 * across the three paths (the platform id would have to literally equal
 * "operator" or start with "github:"), so a user only ever sees their own rows.
 */
export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required to view your tasks." }, { status: 401 });

  let rows: TaskRow[];
  let tenantId: number;
  try {
    const tenant = await resolveTenantContext(request, account, getD1());
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    tenantId = tenant.tenantId;
    const selected: TaskRow[] = await getDb()
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.requestedBy, account.userId)))
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(TASK_PAGE_SIZE);
    rows = visibleTasks(selected, { ...account, tenantId });
  } catch {
    // Mirrors the dispatch path: a D1 problem degrades the feature instead of
    // erroring the page. The task list is informational; nothing depends on it.
    return Response.json({ tasks: [], historyAvailable: false, liveStatus: false });
  }
  if (rows.length === 0) return Response.json({ tasks: [], historyAvailable: true, liveStatus: true });

  const token = await readToken();
  if (!token) return Response.json({ tasks: rows.map((row) => taskView(row, null, null, null)), historyAvailable: true, liveStatus: false });

  const workflowOf = (row: TaskRow) =>
    workflowForMode(row.mode, { defaultWorkflow: process.env.ATLAS_GITHUB_WORKFLOW, coderWorkflow: process.env.ATLAS_CODER_WORKFLOW });

  const runsById = new Map<number, Run>();
  const resolvedRunIds = new Map<string, number>();

  // Only tasks that still have no run id need the (fuzzy) listing pass; once a
  // task owns a run id it is never re-derived.
  const groups = new Map<string, { repository: string; workflow: string }>();
  for (const row of rows) {
    if (row.executionProvider !== "managed" || row.githubRunId !== null) continue;
    const workflow = workflowOf(row);
    // JSON rather than a delimiter string: a repository is "owner/name" and a
    // workflow is a filename, so no single separator character is obviously
    // safe, and the NUL that would be is enough to make git treat this whole
    // file as binary and every future diff of it unreviewable.
    groups.set(JSON.stringify([row.repository, workflow]), { repository: row.repository, workflow });
  }

  await Promise.all(
    [...groups.values()].slice(0, MAX_RUN_LISTINGS).map(async (group) => {
      let payload: unknown = null;
      try {
        payload = await fetchGitHubJson(workflowRunsRequest({ token, repository: group.repository, workflow: group.workflow }));
      } catch { return; }
      const listed = (payload as { workflow_runs?: unknown[] } | null)?.workflow_runs;
      const runs = (Array.isArray(listed) ? listed.map(normalizeRun) : []).filter((run): run is Run => run !== null);
      for (const run of runs) runsById.set(run.id, run);

      const groupRows = rows.filter((row) => row.repository === group.repository && workflowOf(row) === group.workflow);
      const assignments = assignRunsToTasks(
        // Resolved rows are included so their run ids are excluded from the
        // candidate pool — two tasks must never claim the same run.
        groupRows.map((row) => ({ taskId: row.taskId, createdAt: row.createdAt, workflow: group.workflow, githubRunId: row.githubRunId })),
        runs.map((run) => ({ ...run, workflow: group.workflow })),
      );
      for (const assignment of assignments) resolvedRunIds.set(assignment.taskId, assignment.runId);
    }),
  );

  if (resolvedRunIds.size > 0) {
    try {
      const db = getDb();
      await Promise.all(
        [...resolvedRunIds].map(([taskId, runId]) =>
          db.update(tasks).set({ githubRunId: runId }).where(and(eq(tasks.taskId, taskId), eq(tasks.tenantId, tenantId), eq(tasks.requestedBy, account.userId))),
        ),
      );
    } catch {
      // Best effort: the id will simply be re-derived on the next poll.
    }
  }

  const runIdFor = (row: TaskRow) => row.githubRunId ?? resolvedRunIds.get(row.taskId) ?? null;

  // Tasks older than the listing window still need their final status.
  const missing = rows
    .map((row) => ({ repository: row.repository, runId: runIdFor(row) }))
    .filter((entry): entry is { repository: string; runId: number } => entry.runId !== null && !runsById.has(entry.runId))
    .slice(0, MAX_RUN_LOOKUPS);
  await Promise.all(
    missing.map(async (entry) => {
      try {
        const run = normalizeRun(await fetchGitHubJson(workflowRunRequest({ token, repository: entry.repository, runId: entry.runId })));
        if (run) runsById.set(run.id, run);
      } catch { /* leaves the task at its last known status */ }
    }),
  );

  const pullRequests = new Map<string, PullRequest>();
  await Promise.all(
    rows
      .filter((row) => row.executionProvider === "managed" && row.mode === "coder" && runIdFor(row) !== null)
      .slice(0, MAX_PULL_REQUEST_LOOKUPS)
      .map(async (row) => {
        try {
          const payload = await fetchGitHubJson(
            pullRequestForBranchRequest({ token, repository: row.repository, branch: coderBranchForTask(row.taskId) }),
          );
          const pullRequest = Array.isArray(payload) ? normalizePullRequest(payload[0]) : null;
          if (pullRequest) pullRequests.set(row.taskId, pullRequest);
        } catch { /* degrades to no pull-request link */ }
      }),
  );

  return Response.json({
    tasks: rows.map((row) => {
      const runId = runIdFor(row);
      return taskView(row, runId, runId === null ? null : runsById.get(runId) ?? null, pullRequests.get(row.taskId) ?? null);
    }),
    historyAvailable: true,
    liveStatus: true,
  });
}

async function readToken(): Promise<string | undefined> {
  try {
    const githubApp = githubAppConfiguration();
    if (githubApp.configured) return await createInstallationToken(githubApp);
  } catch {
    // Falls through to the personal token, then to no live status at all.
  }
  return platformGitHubToken();
}

function taskView(row: TaskRow, runId: number | null, run: Run | null, pullRequest: PullRequest | null) {
  return {
    taskId: row.taskId,
    conversationId: row.conversationId,
    correlationId: row.correlationId ?? null,
    repository: row.repository,
    branch: row.branch,
    mode: row.mode,
    objective: row.objective,
    mergePolicy: row.mergePolicy,
    createdAt: row.createdAt,
    status: row.executionProvider === "private" && run === null ? "dispatched" : taskStatusFromRun(run),
    executionProvider: row.executionProvider,
    run: runId === null ? null : { id: runId, url: run?.htmlUrl ?? runUrl(row.repository, runId), status: run?.status ?? null, conclusion: run?.conclusion ?? null },
    pullRequest,
  };
}
