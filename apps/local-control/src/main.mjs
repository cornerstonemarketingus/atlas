import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalControlServer } from "./server.mjs";
import { runIsolatedLocalCoder } from "./runner.mjs";
import { LocalTaskStore } from "./store.mjs";
import { verifyOfflineLicense } from "./offline-license.mjs";
import { AgentSessionStore } from "./agent/session-store.mjs";
import { AgentRuntime } from "./agent/runtime.mjs";
import { PlatformTaskStore } from "./platform/task-store.mjs";
import { createLegacyPolicyBridge, createLegacyPolicyEngine } from "./platform/legacy-policy-bridge.mjs";
import { AuthorizedToolExecutor } from "./platform/executor.mjs";
import { adaptRegistryTool } from "./platform/adapters.mjs";
import { bootstrapInnovation } from "./platform/innovation/bootstrap.mjs";
import { OutboxDispatcher, createEventStream } from "./platform/outbox-dispatcher.mjs";
import { LOCAL_TENANT_ID } from "./platform/dashboard.mjs";
import { createGitHubActionsExecutor, createLocalExecutor } from "./agent/executors.mjs";
import { createGitHubActionsClient } from "./agent/github-actions-client.mjs";
import { createConversationExecutor } from "./agent/conversation-executor.mjs";
import { createModelClient } from "./agent/model-client.mjs";
import { createSpeechTranscriber } from "./agent/speech.mjs";
import { MissionService } from "./agent/mission-service.mjs";
import { createLaneApplier } from "./agent/lane-apply.mjs";
import { detectHardware } from "./agent/models/hardware.mjs";
import { ModelManager } from "./agent/models/manager.mjs";
import { ModelPlanStore } from "./agent/models/hosting.mjs";
import { discoverModelServers } from "./agent/models/discovery.mjs";
import { recommendModels } from "./agent/models/recommend.mjs";
import { createModelRouter, describeRoutes, parseRoutes } from "./agent/models/router.mjs";
import { createRoutedClient } from "./agent/models/routed-client.mjs";
import { createTeamService } from "./agent/team/team-service.mjs";
import { createDaemonSelfImprovement, registerSelfImproveTool } from "./platform/self-improve/index.mjs";
import { createAgentStepExecutor } from "./agent/team/step-executor.mjs";
import { ToolRegistry } from "./agent/tool-registry.mjs";
import { ScopedMemoryStore } from "./platform/memory/memory-store.mjs";
import { connectMcpServers, parseMcpServers } from "./platform/mcp/daemon-bridge.mjs";
import { registerRepositoryTools } from "./agent/tools/repository-tools.mjs";
import { registerRepositoryWriteTools } from "./agent/tools/repository-write-tools.mjs";
import { registerFilesystemTools } from "./agent/tools/filesystem-tools.mjs";
import { registerBrowserTools } from "./agent/tools/browser-tools.mjs";
import { registerDesktopTools } from "./agent/tools/desktop-tools.mjs";
import { registerTerminalTools } from "./agent/tools/terminal-tools.mjs";
import { registerCommunicationsTools } from "./agent/tools/communications-tools.mjs";
import { registerWorkflowTools } from "./agent/tools/workflow-tools.mjs";
import { registerInfrastructureTools } from "./agent/tools/infrastructure-tools.mjs";
import { createCredentialVault } from "./agent/credential-vault.mjs";
import { openInBrowser, ownerAccount, resolveOwnerToken, signInUrl } from "./identity/owner.mjs";
import { RemoteAccess } from "./remote/access.mjs";
import { ACTIVE_STATES, GenesisService, GenesisStore } from "./platform/genesis/index.mjs";
import { GenesisExecutor } from "./platform/genesis/executor.mjs";
import { registerGenesisTools } from "./platform/genesis/tools.mjs";
import { GenesisPublisher } from "./platform/genesis/publish.mjs";
import { PreviewManager } from "./platform/genesis/preview.mjs";
import { createInspector } from "./platform/genesis/inspector.mjs";
import { createVisionReviewer } from "./platform/genesis/vision.mjs";
import { createGenesisCoder } from "./platform/genesis/coder.mjs";
import { runCheck } from "./platform/self-improve/runtime.mjs";
import { createCloudflareAdapter } from "./agent/infrastructure/cloudflare.mjs";
import { createVercelAdapter } from "./agent/infrastructure/vercel.mjs";
import { createGitHostAdapter } from "./agent/infrastructure/git-hosts.mjs";

const dataDirectory = process.env.ATLAS_LOCAL_DATA_DIR || join(homedir(), ".atlas");
mkdirSync(dataDirectory, { recursive: true });

const store = new LocalTaskStore(join(dataDirectory, "atlas.sqlite"));
const sessions = new AgentSessionStore(join(dataDirectory, "agent.sqlite"));
const platformStore = new PlatformTaskStore(join(dataDirectory, "platform.sqlite"));
// The agent organization (Business Development Executive → Product Executive →
// specialists, plus the Engineering, Design, Computer Operations and Research
// peers) and the Innovation Backlog it works from.
const innovation = bootstrapInnovation({ filename: join(dataDirectory, "organization.sqlite"), store, platformStore });
// Every platform event committed to the outbox is delivered from here: today
// to live dashboard clients; failures retry and then dead-letter visibly.
const platformStream = createEventStream({ tenantFor: () => LOCAL_TENANT_ID });
const outbox = new OutboxDispatcher({ store: platformStore, onError: (error) => console.error("Outbox delivery failed:", error instanceof Error ? error.message : error) });
outbox.subscribe("*", (event) => platformStream.publish(event));
outbox.start();
const vault = createCredentialVault({ filePath: join(dataDirectory, "credentials.vault.json") });
// Local identity: the OS account that runs Atlas owns it; its token lives in that account's vault.
const owner = ownerAccount();
const ownerToken = await resolveOwnerToken({ dataDirectory, vault, log: (line) => console.log(line) });
const token = ownerToken.token;
if (ownerToken.created) console.log(`Created the owner token for ${owner.user} (stored in ${ownerToken.storage === "file" ? join(dataDirectory, "local-token") : `the ${ownerToken.storage} vault`}). Sign in with: node scripts/local/open-atlas.mjs`);

const license = loadLicense();
// One model client (routed, with fallback) and one tool registry serve both
// conversations and agent missions, so policy and approvals are identical.
const modelClient = createRoutedClient({
  routes: parseRoutes(process.env.ATLAS_MODEL_ROUTES ?? "[]"),
  task: "planning",
  createClient: (route) => createModelClient({ baseUrl: route.endpoint }),
  fallback: createModelClient({ baseUrl: process.env.ATLAS_MODEL_ENDPOINT || undefined }),
  onRoute: (route, { failedOver }) => store.audit("model.route", `${route.model} served a model turn${failedOver ? " after failover" : ""}`),
});
// Models → Install → Run: Atlas manages a loopback model server and the applied model plan.
const modelManager = new ModelManager({ log: (line) => store.audit("model.hosting", line) });
const modelPlan = new ModelPlanStore(join(dataDirectory, "model-plan.json"));
// "Atlas, improve yourself": only when running from a git checkout of Atlas itself.
const selfImprove = createDaemonSelfImprovement({ atlasRoot: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), dataDirectory, modelPlan });
const toolRegistry = buildToolRegistry();
const authorizedToolExecutor = buildAuthorizedToolExecutor(toolRegistry);
const toolApprovals = {
  // One-time and digest-bound: spending an approval consumes it, and it
  // only matches the exact action it was granted for.
  check: (digest) => store.consumeApprovedDigest(digest),
  request: ({ digest, capability, summary, sessionId }) =>
    store.createApproval({ capability, summary, actionDigest: digest, sessionId }),
  // Agent steps wait on the owner's decision rather than failing.
  status: (id) => store.approval(id)?.status ?? null,
};
// Scoped, provenance-carrying memory: agents recall their family's verified
// work and the owner can search, inspect and delete it under Knowledge.
const memory = new ScopedMemoryStore(join(dataDirectory, "memory.sqlite"));
memory.expire();
setInterval(() => { try { memory.expire(); } catch { /* retried next hour */ } }, 60 * 60 * 1000).unref();
// MCP servers the owner configured. Their tools join the same registry, so
// they are denied until the owner allows the server's `mcp.<id>` capability.
let mcpReport = [];
try {
  const servers = parseMcpServers(process.env.ATLAS_MCP_SERVERS);
  if (servers.length) {
    connectMcpServers({
      registry: toolRegistry,
      servers,
      audit: (event) => store.audit(event.type ?? "mcp", `${event.serverId}${event.tool ? `/${event.tool}` : ""} ${event.outcome ?? ""}${event.reason ? ` (${event.reason})` : ""}`.trim()),
    }).then(({ report }) => {
      mcpReport = report;
      for (const entry of report) console.log(`MCP server ${entry.id}: ${entry.status}${entry.tools ? ` (${entry.tools.length} tools)` : entry.message ? ` — ${entry.message}` : ""}`);
    }, (error) => { mcpReport = [{ id: "*", status: "failed", message: error.message }]; });
  }
} catch (error) {
  mcpReport = [{ id: "*", status: "failed", message: error.message }];
  console.error(error.message);
}
const runtime = new AgentRuntime({
  sessions,
  executors: buildExecutors(),
  platformStore,
  audit: (category, summary) => store.audit(category, summary),
});
// Anything left running by the previous process is reconciled before the
// first request arrives, so a client never sees a session that claims to be
// running inside a runtime that no longer exists.
const recovered = runtime.recover();
if (recovered.length > 0) console.log(`Recovered ${recovered.length} interrupted session(s).`);

const missionService = new MissionService({ store, execute: runMissionChild });
// Applying a finished lane's patch to the owner's repository goes through code.write approvals.
const laneApplier = createLaneApplier({ missionService, store, dataDirectory });
// Agent missions: goal → plan over the agent organization → steps run by the
// assigned agents on the same mission scheduler as coder missions.
const teamStep = createAgentStepExecutor({
  family: innovation.registry,
  delegation: innovation.pipeline.delegation,
  toolRegistry,
  authorizedExecutor: authorizedToolExecutor,
  client: modelClient,
  platformStore,
  approvals: toolApprovals,
  memory,
  resultsOf: (missionId, ids) => (missionService.get(missionId)?.children ?? [])
    .filter((c) => ids.includes(c.id))
    .map((c) => ({ title: c.metadata?.stepTitle ?? c.id, summary: c.result?.handoff?.report ?? c.result?.summary ?? "" })),
});
const team = createTeamService({
  family: innovation.registry,
  delegation: innovation.pipeline.delegation,
  missionService,
  platformStore,
  toolRegistry,
  client: modelClient,
  model: process.env.ATLAS_TEAM_MODEL || process.env.ATLAS_MODEL || "qwen2.5-coder:7b",
  workspace: join(dataDirectory, "workspace"),
});
const recoveredMissions = missionService.recover();
team.reattach();
if (recoveredMissions.length > 0) console.log(`Recovered ${recoveredMissions.length} interrupted mission(s); operator resume is required.`);

// Project Genesis: idea → requirements → plan → build → verify → preview → ready, durable across restarts.
const genesisStore = new GenesisStore(join(dataDirectory, "genesis.sqlite"));
const genesis = new GenesisService({
  store: genesisStore,
  policy: (capability) => store.policy(capability),
  onChange: (project) => {
    store.audit("genesis.transition", `${project.name}: ${project.state}`);
    // Approved or resumed work starts (or continues) without the owner running anything.
    if ((project.state === "approved" || ACTIVE_STATES.includes(project.state)) && genesisExecutor && !genesisExecutor.isRunning(project.id)) genesisExecutor.run(project.id).catch(() => {});
  },
});
const genesisPreviews = new PreviewManager({ registryPath: join(dataDirectory, "genesis", "previews.json"), runPrepare: runCheck, log: (line) => store.audit("genesis.preview", line) });
for (const result of genesisPreviews.cleanupOrphans()) if (result.action === "stopped") console.log(`Genesis: stopped a preview left running by a previous Atlas (${result.projectId}).`);
const genesisExecutor = new GenesisExecutor({
  genesis,
  projectsRoot: join(dataDirectory, "genesis", "projects"),
  runCheck,
  coder: createGenesisCoder({ atlasRoot: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), dataDirectory, modelPlan, intelligence: genesis.intelligence }),
  preview: genesisPreviews,
  inspector: createInspector({ artifactsRoot: join(dataDirectory, "genesis", "inspections"), vision: createVisionReviewer() }),
});
for (const project of genesis.recover()) console.log(`Genesis: ${project.name} was interrupted and is paused.`);
// Publishing a finished project is external: it goes through the publish.remote policy and the normal approvals.
const genesisPublisher = new GenesisPublisher({
  genesis,
  approvals: { policy: (capability) => store.policy(capability), create: (request) => store.createApproval(request), get: (id) => store.approval(id) },
  // Host and deployment tokens come from the OS-backed vault first, like every other credential.
  credentials: async (name) => (await vault.get(name).catch(() => null)) ?? process.env[name] ?? null,
  runCheck,
});
const port = Number(process.env.ATLAS_LOCAL_PORT || 4317);
// Remote access stays customer-managed (your VPN or HTTPS proxy); Atlas itself keeps listening on loopback.
const remoteAccess = new RemoteAccess({ port, settingsPath: join(dataDirectory, "remote-access.json") });
const server = createLocalControlServer({
  store,
  token,
  runTask: (task) => runIsolatedLocalCoder(task, { dataDirectory }),
  license,
  runtime,
  missionService,
  platformStore,
  innovation,
  platformStream,
  team,
  memory,
  connections: () => mcpReport,
  toolCatalog: () => toolRegistry.list(),
  selfImprove,
  identity: { owner, tokenStorage: ownerToken.storage },
  remoteAccess,
  genesis,
  genesisPreviews,
  genesisPublisher,
  onApprovalDecided: async (approval) => {
    await laneApplier.onApprovalDecided(approval);
    return genesisPublisher.onApprovalDecided(approval);
  },
  laneApplier,
  modelHosting: { manager: modelManager, planStore: modelPlan, detectHardware },
  // The platform write API reuses the daemon's own instances, never second copies.
  platformServices: { family: innovation.registry, memory },
  transcriber: buildTranscriber(),
  modelHealth: reportModelHealth,
});
const host = process.env.ATLAS_LOCAL_HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`Atlas sovereign control plane: http://${host}:${port}\nAgent runtime ${runtime.instanceId} executors: ${runtime.executorIds().join(", ")}`);
  if (process.env.ATLAS_OPEN_BROWSER === "1") openInBrowser(signInUrl(`http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`, token));
});

async function runMissionChild({ child, signal, budget, checkpoint }) {
  if (child.metadata?.kind === "agent_step") return teamStep({ child, signal, budget, checkpoint });
  await checkpoint();
  budget.record({ toolCalls: 1 });
  const repository = child.metadata?.repository;
  const model = child.metadata?.model;
  if (!repository || !model) return { status: "failed", code: "INVALID_CHILD", summary: "The mission child is missing its repository or model." };
  const result = await runIsolatedLocalCoder(
    { id: `${child.id}-${randomBytes(8).toString("hex")}`, repository, objective: child.objective, model },
    { dataDirectory, signal },
  );
  await checkpoint();
  return {
    status: result.ok ? "completed" : result.cancelled ? "cancelled" : "failed",
    summary: result.message ?? (result.ok ? "Child completed." : "Child failed."),
    evidence: result.patch ? [{ kind: "patch", path: result.patch, bytes: result.patchBytes ?? null }] : [],
    handoff: { worktree: result.worktree ?? null, patch: result.patch ?? null },
  };
}

function shutdown() {
  modelManager.stopServer();
  genesisPreviews.stopAll().catch(() => {});
  server.close(async () => {
    await runtime.stop();
    await outbox.stop();
    sessions.close();
    innovation.close();
    genesisStore.close();
    platformStore.close();
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/**
 * Local execution is always available. GitHub Actions is registered only when
 * this machine has been given a token for it — the runtime works, and every
 * acceptance test passes, with the remote executor absent entirely.
 */
function buildExecutors() {
  const executors = {
    local: createLocalExecutor({ dataDirectory }),
    conversation: createConversationExecutor({
      client: modelClient,
      registry: toolRegistry,
      approvals: toolApprovals,
    }),
  };
  const token = process.env.ATLAS_GITHUB_TOKEN;
  const repository = process.env.ATLAS_GITHUB_REPOSITORY;
  const workflow = process.env.ATLAS_GITHUB_WORKFLOW || "atlas-coder.yml";
  if (token && repository) {
    const client = createGitHubActionsClient({ token, repository, workflow, ref: process.env.ATLAS_GITHUB_REF || "main" });
    executors["github-actions"] = createGitHubActionsExecutor({ dispatch: (input) => client.dispatch(input), poll: (input) => client.poll(input) });
  }
  return executors;
}

/**
 * Policy comes from the same allow/ask/deny table the operator already edits
 * in the local UI. A capability with no row is denied.
 */
function buildToolRegistry() {
  const registry = new ToolRegistry({
    policy: createLegacyPolicyBridge({
      policyForCapability: (capability) => store.policy(capability),
      audit: (event) => {
        store.audit("policy.decision", `${event.tool} ${event.effect}: ${event.reasons.join("; ")}`);
        if (event.taskId && event.toolCallId && event.decision) {
          try {
            platformStore.transaction(() => {
              platformStore.recordPolicyDecision(event.decision, {
                toolCallId: event.toolCallId,
                correlationId: event.correlationId,
              });
              platformStore.updateToolCall(event.tenantId, event.toolCallId, { policyDecisionId: event.decision.id });
            });
          } catch (error) {
            store.audit("policy.persistence_failed", `${event.tool}: ${error.code ?? "POLICY_AUDIT_FAILED"}`);
          }
        }
      },
    }),
    // Secrets resolve by reference, from the OS-backed credential vault first
    // and the process environment only as a fallback for existing setups
    // (SECURITY-REVIEW SEC-8). No tool receives a value it did not declare.
    secrets: async (reference) => (await vault.get(reference).catch(() => null)) ?? process.env[reference] ?? null,
  });
  registerRepositoryTools(registry);
  registerRepositoryWriteTools(registry);
  registerFilesystemTools(registry, { roots: [join(dataDirectory, "workspace")] });
  registerCommunicationsTools(registry, { send: null });
  // Starting a run asks the owner first (requiresApproval); merging a result is a second, separate decision.
  registerSelfImproveTool(registry, selfImprove);
  // Genesis is created after the registry; the tools look it up when they run.
  registerGenesisTools(registry, () => genesis, () => genesisPublisher);
  registerWorkflowTools(registry);
  // The browser family is registered whether or not a companion is attached:
  // its tools then fail closed with "no browser on this machine", which is a
  // better answer than the model never learning the capability exists.
  registerBrowserTools(registry, { session: buildBrowserSession, uploadRoot: join(dataDirectory, "workspace") });
  // Desktop control: same companion runtime and rules; fails closed with a
  // structured reason on machines without a supported desktop.
  registerDesktopTools(registry, { session: buildDesktopSession });
  // Terminal: the platform controller (no shell, allowlist, per-session
  // workspace). High-risk commands need an approval bound to the command.
  registerTerminalTools(registry, { controller: buildTerminalController });
  registerInfrastructureTools(registry, { providers: buildInfrastructureProviders(), vault });
  return registry;
}

function buildAuthorizedToolExecutor(registry) {
  const capabilityByTool = new Map(registry.list().map((tool) => [tool.name, tool.capability]));
  const policy = createLegacyPolicyEngine({
    capabilityForTool: (name) => capabilityByTool.get(name) ?? name,
    policyForCapability: (capability) => store.policy(capability),
    audit: (event) => store.audit("policy.decision", `${event.tool} ${event.effect}: ${event.reasons.join("; ")}`),
  });
  const executor = new AuthorizedToolExecutor({ store: platformStore, policy });
  for (const definition of registry.list()) {
    const adapted = adaptRegistryTool(registry.get(definition.name));
    executor.register(adapted.tool, { timeoutMs: adapted.timeoutMs });
  }
  return executor;
}

/**
 * Builds the computer-operation session on first use.
 *
 * The operator runtime — classification, approval gating, CAPTCHA detection,
 * evidence — lives with the Windows companion, because that is the component
 * that ships to a customer's machine. The daemon drives the same runtime over
 * a Playwright page when one is available here. On a machine with neither, the
 * browser tools answer "no browser on this machine", which is the honest
 * answer rather than a missing capability.
 */
async function buildBrowserSession() {
  const [{ createPlaywrightPage, createLocalScreenshotStore }, { createOperatorSession }] = await Promise.all([
    import("./agent/browser/playwright-page.mjs"),
    import("../../windows-companion/src/operator/session.mjs"),
  ]);
  const page = await createPlaywrightPage({
    profileDirectory: join(dataDirectory, "browser-profile"),
    downloadDirectory: join(dataDirectory, "workspace", "downloads"),
  });
  return createOperatorSession({
    page,
    // Screenshots are written to the operator's disk. Sending one anywhere is
    // a separate, approval-bound decision.
    screenshots: createLocalScreenshotStore(join(dataDirectory, "screenshots")),
    approvals: {
      request: async ({ digest, summary }) => {
        // The operator session asks here; the registry's own approval gate has
        // already run for the tool call, so this covers the page-level action
        // the model is about to take on a specific element.
        store.createApproval({ capability: "computer.high_risk", summary, actionDigest: digest });
        return store.consumeApprovedDigest(digest);
      },
    },
  });
}

/** The platform terminal controller, rooted in the daemon's own workspace area. */
async function buildTerminalController() {
  const [{ TerminalController }, { createHash }, { mkdirSync: makeDirectory }] = await Promise.all([
    import("./platform/terminal/terminal-controller.mjs"),
    import("node:crypto"),
    import("node:fs"),
  ]);
  const rootDirectory = join(dataDirectory, "terminal-workspaces");
  makeDirectory(rootDirectory, { recursive: true });
  // Optional container isolation (issue #72). When a runtime is named and
  // cannot be used, construction throws: the daemon never quietly falls back
  // to running commands as the operator.
  const containerRuntime = process.env.ATLAS_TERMINAL_CONTAINER_RUNTIME?.trim();
  const container = containerRuntime
    ? { runtime: containerRuntime, ...(process.env.ATLAS_TERMINAL_CONTAINER_IMAGE?.trim() ? { image: process.env.ATLAS_TERMINAL_CONTAINER_IMAGE.trim() } : {}) }
    : undefined;
  return new TerminalController({
    rootDirectory,
    container,
    approve: ({ argv, reasons }) => {
      const digest = createHash("sha256").update(JSON.stringify(argv)).digest("hex");
      if (store.consumeApprovedDigest(digest)) return true;
      store.createApproval({ capability: "terminal.run", summary: `Run \`${argv.join(" ").slice(0, 200)}\` (${reasons.join("; ")})`, actionDigest: digest });
      return false;
    },
  });
}

/**
 * Builds the desktop operating session on first use, from the companion's
 * driver and rules. Approvals for consequential desktop actions land in the
 * local approvals inbox, bound to the exact action's digest.
 */
async function buildDesktopSession() {
  const [{ createDesktopDriver, DesktopSession }, { createHash }] = await Promise.all([
    import("../../windows-companion/src/desktop/index.mjs"),
    import("node:crypto"),
  ]);
  return new DesktopSession({
    driver: createDesktopDriver(),
    evidenceDir: join(dataDirectory, "screenshots", "desktop"),
    approve: async ({ action, risk, window }) => {
      const digest = createHash("sha256").update(JSON.stringify(action)).digest("hex");
      if (store.consumeApprovedDigest(digest)) return;
      store.createApproval({ capability: "desktop.control", summary: `${risk.reason}${window ? ` (${window})` : ""}`, actionDigest: digest });
      throw Object.assign(new Error("This desktop action needs your approval. Approve it in Atlas, then ask again."), { code: "APPROVAL_REQUIRED" });
    },
  });
}

/**
 * Providers are resolved lazily, so a machine with no infrastructure
 * credentials still starts and still offers the tools — they simply answer
 * "not configured on this machine" instead of silently not existing.
 *
 * The tokens here are administration credentials. They are deliberately
 * separate from anything the coding agent holds: nothing Atlas gives the
 * coder can mint or change a credential, which is the whole point of keeping
 * these behind the vault and behind approval.
 */
function buildInfrastructureProviders() {
  const lazily = (name, build) => {
    let cached;
    return () => {
      if (cached === undefined) cached = build() ?? null;
      if (!cached) throw new Error(`No ${name} credentials are configured on this machine.`);
      return cached;
    };
  };
  const providers = {};
  if (process.env.ATLAS_CLOUDFLARE_TOKEN) {
    providers.cloudflare = lazily("Cloudflare", () => createCloudflareAdapter({ token: process.env.ATLAS_CLOUDFLARE_TOKEN }));
  }
  if (process.env.ATLAS_VERCEL_TOKEN) {
    providers.vercel = lazily("Vercel", () => createVercelAdapter({ token: process.env.ATLAS_VERCEL_TOKEN, teamId: process.env.ATLAS_VERCEL_TEAM_ID || null }));
  }
  if (process.env.ATLAS_GITHUB_TOKEN && process.env.ATLAS_GITHUB_REPOSITORY) {
    providers.gitHost = lazily("Git host", () => createGitHostAdapter({
      host: process.env.ATLAS_GIT_HOST || "github",
      token: process.env.ATLAS_GITHUB_TOKEN,
      repository: process.env.ATLAS_GITHUB_REPOSITORY,
      baseUrl: process.env.ATLAS_GIT_HOST_BASE_URL || null,
    }));
  }
  return providers;
}

const router = createModelRouter({
  routes: parseRoutes(process.env.ATLAS_MODEL_ROUTES ?? "[]"),
  createClient: (route) => createModelClient({ baseUrl: route.endpoint }),
});

/**
 * What an operator needs to judge whether their models are healthy: what this
 * machine can run, what is installed, what Atlas would pick, and how the
 * routes are configured. No credential appears anywhere in it — that is the
 * whole point of reporting health separately from configuration.
 */
async function reportModelHealth() {
  // The configured endpoint and routes are checked too, not only the default local ports.
  const endpoints = [...new Set(["http://127.0.0.1:11434/v1", "http://127.0.0.1:8080/v1", process.env.ATLAS_MODEL_ENDPOINT, ...router.routes.map((route) => route.endpoint)].filter(Boolean).map((endpoint) => endpoint.replace(/\/+$/u, "")))];
  const [hardware, servers] = await Promise.all([detectHardware(), discoverModelServers({ endpoints })]);
  const installed = servers.flatMap((server) => server.models);
  return {
    hardware,
    servers: servers.map((server) => ({
      // A host, not a URL with anything in it.
      location: server.endpoint.includes("127.0.0.1") || server.endpoint.includes("localhost") ? "this machine" : new URL(server.endpoint).host,
      kind: server.kind,
      models: server.models,
    })),
    ...recommendModels({ hardware, installed }),
    routes: describeRoutes(router),
  };
}

function buildTranscriber() {
  try {
    return createSpeechTranscriber();
  } catch {
    // A misconfigured endpoint disables dictation; it must not stop Atlas.
    return null;
  }
}

function loadLicense() {
  const licensePath = process.env.ATLAS_OFFLINE_LICENSE_FILE;
  const publicKeyPath = process.env.ATLAS_LICENSE_PUBLIC_KEY_FILE;
  if (!licensePath && !publicKeyPath) return { mode: "community", valid: true };
  if (!licensePath || !publicKeyPath) throw new Error("Both ATLAS_OFFLINE_LICENSE_FILE and ATLAS_LICENSE_PUBLIC_KEY_FILE are required.");
  const document = JSON.parse(readFileSync(licensePath, "utf8"));
  const result = verifyOfflineLicense(document, readFileSync(publicKeyPath, "utf8"));
  if (!result.valid) throw new Error(`Offline license is not valid: ${result.reason}.`);
  return { mode: "licensed", valid: true, tier: result.claims.tier, expiresAt: result.claims.expiresAt, licenseId: result.claims.licenseId };
}
