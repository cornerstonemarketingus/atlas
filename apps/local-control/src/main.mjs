import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLocalControlServer } from "./server.mjs";
import { runIsolatedLocalCoder } from "./runner.mjs";
import { LocalTaskStore } from "./store.mjs";
import { verifyOfflineLicense } from "./offline-license.mjs";
import { AgentSessionStore } from "./agent/session-store.mjs";
import { AgentRuntime } from "./agent/runtime.mjs";
import { createGitHubActionsExecutor, createLocalExecutor } from "./agent/executors.mjs";
import { createGitHubActionsClient } from "./agent/github-actions-client.mjs";
import { createConversationExecutor } from "./agent/conversation-executor.mjs";
import { createModelClient } from "./agent/model-client.mjs";
import { createSpeechTranscriber } from "./agent/speech.mjs";
import { ToolRegistry } from "./agent/tool-registry.mjs";
import { registerRepositoryTools } from "./agent/tools/repository-tools.mjs";
import { registerRepositoryWriteTools } from "./agent/tools/repository-write-tools.mjs";
import { registerFilesystemTools } from "./agent/tools/filesystem-tools.mjs";
import { registerBrowserTools } from "./agent/tools/browser-tools.mjs";
import { registerCommunicationsTools } from "./agent/tools/communications-tools.mjs";
import { registerWorkflowTools } from "./agent/tools/workflow-tools.mjs";
import { registerInfrastructureTools } from "./agent/tools/infrastructure-tools.mjs";
import { createCredentialVault } from "./agent/credential-vault.mjs";
import { createCloudflareAdapter } from "./agent/infrastructure/cloudflare.mjs";
import { createVercelAdapter } from "./agent/infrastructure/vercel.mjs";
import { createGitHostAdapter } from "./agent/infrastructure/git-hosts.mjs";

const dataDirectory = process.env.ATLAS_LOCAL_DATA_DIR || join(homedir(), ".atlas");
const tokenFile = join(dataDirectory, "local-token");
mkdirSync(dataDirectory, { recursive: true });
let token = process.env.ATLAS_LOCAL_TOKEN;
if (!token) {
  try { token = readFileSync(tokenFile, "utf8").trim(); }
  catch {
    token = randomBytes(32).toString("base64url");
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
    console.log(`Local access token (saved to ${tokenFile}):\n${token}`);
  }
}

const store = new LocalTaskStore(join(dataDirectory, "atlas.sqlite"));
const sessions = new AgentSessionStore(join(dataDirectory, "agent.sqlite"));
const vault = createCredentialVault({ filePath: join(dataDirectory, "credentials.vault.json") });
const license = loadLicense();
const runtime = new AgentRuntime({
  sessions,
  executors: buildExecutors(),
  audit: (category, summary) => store.audit(category, summary),
});
// Anything left running by the previous process is reconciled before the
// first request arrives, so a client never sees a session that claims to be
// running inside a runtime that no longer exists.
const recovered = runtime.recover();
if (recovered.length > 0) console.log(`Recovered ${recovered.length} interrupted session(s).`);

const server = createLocalControlServer({
  store,
  token,
  runTask: (task) => runIsolatedLocalCoder(task, { dataDirectory }),
  license,
  runtime,
  transcriber: buildTranscriber(),
});
const host = process.env.ATLAS_LOCAL_HOST || "127.0.0.1";
const port = Number(process.env.ATLAS_LOCAL_PORT || 4317);
server.listen(port, host, () => console.log(`Atlas sovereign control plane: http://${host}:${port}\nAgent runtime ${runtime.instanceId} executors: ${runtime.executorIds().join(", ")}`));

function shutdown() {
  server.close(async () => {
    await runtime.stop();
    sessions.close();
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
      client: createModelClient({ baseUrl: process.env.ATLAS_MODEL_ENDPOINT || undefined }),
      registry: buildToolRegistry(),
      approvals: {
        // One-time and digest-bound: spending an approval consumes it, and it
        // only matches the exact action it was granted for.
        check: (digest) => store.consumeApprovedDigest(digest),
        request: ({ digest, capability, summary, sessionId }) =>
          store.createApproval({ capability, summary, actionDigest: digest, sessionId }),
      },
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
    policy: (capability) => store.policy(capability).decision,
    // Secrets are read from the process environment for now, by reference
    // only. No tool receives a value it did not declare a need for.
    secrets: (reference) => process.env[reference] ?? null,
  });
  registerRepositoryTools(registry);
  registerRepositoryWriteTools(registry);
  registerFilesystemTools(registry, { roots: [join(dataDirectory, "workspace")] });
  registerCommunicationsTools(registry, { send: null });
  registerWorkflowTools(registry);
  // The browser family is registered whether or not a companion is attached:
  // its tools then fail closed with "no browser on this machine", which is a
  // better answer than the model never learning the capability exists.
  registerBrowserTools(registry, { session: null, uploadRoot: join(dataDirectory, "workspace") });
  registerInfrastructureTools(registry, { providers: buildInfrastructureProviders(), vault });
  return registry;
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
