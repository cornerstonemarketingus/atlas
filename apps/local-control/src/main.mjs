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
  const executors = { local: createLocalExecutor({ dataDirectory }) };
  const token = process.env.ATLAS_GITHUB_TOKEN;
  const repository = process.env.ATLAS_GITHUB_REPOSITORY;
  const workflow = process.env.ATLAS_GITHUB_WORKFLOW || "atlas-coder.yml";
  if (token && repository) {
    const client = createGitHubActionsClient({ token, repository, workflow, ref: process.env.ATLAS_GITHUB_REF || "main" });
    executors["github-actions"] = createGitHubActionsExecutor({ dispatch: (input) => client.dispatch(input), poll: (input) => client.poll(input) });
  }
  return executors;
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
