import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROVIDERS = ["anthropic", "groq", "openai", "workers-ai"];
/** Non-secret settings a provider needs besides its key (Workers AI routes by account). */
const PASS_THROUGH = Object.freeze({ "workers-ai": ["CLOUDFLARE_ACCOUNT_ID"] });

/** `provider:model:API_KEY_ENV[:base-url]`. The key's value is read from the environment only. */
export function parseTarget(spec) {
  const [provider, model, apiKeyEnv, ...rest] = String(spec).split(":");
  if (!PROVIDERS.includes(provider) || !model || !/^[A-Z][A-Z0-9_]*$/u.test(apiKeyEnv ?? "")) {
    throw new Error(`target must be provider:model:API_KEY_ENV[:base-url] with provider in ${PROVIDERS.join("|")}`);
  }
  return { provider, model, apiKeyEnv, baseUrl: rest.length > 0 ? rest.join(":") : undefined };
}

/** Reads the coder's redacted audit trace for the measures its JSON receipt lacks. */
export function measureAuditLog(text) {
  let toolErrors = 0;
  let started = null;
  let ttftMs = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const at = Date.parse(event.occurredAt);
    if (event.type === "session.started") started = at;
    else if (event.type === "model.responded" && ttftMs === null && started !== null && Number.isFinite(at)) ttftMs = Math.max(0, at - started);
    else if (event.type === "tool.completed" && event.payload?.outcome === "failed") toolErrors++;
  }
  return { toolErrors, ttftMs };
}

/**
 * Drives `atlas code` against the workspace. The child gets PATH, HOME, the
 * one named key variable and the provider's non-secret settings (Workers AI's
 * account id), never the rest of this process's environment.
 */
export function atlasCliAgent({ cliPath, env = process.env, extraArgs = [] }) {
  return async ({ root, objective, target, signal }) => {
    const spec = parseTarget(target);
    const key = env[spec.apiKeyEnv];
    if (!key) throw new Error(`${spec.apiKeyEnv} is not set`);
    const scratch = await mkdtemp(join(tmpdir(), "atlas-eval-audit-"));
    const auditLog = join(scratch, "audit.jsonl");
    try {
      const args = [cliPath, "code", root, objective, "--provider", spec.provider, "--model", spec.model, "--api-key-env", spec.apiKeyEnv,
        ...(spec.baseUrl ? ["--base-url", spec.baseUrl] : []), "--no-verify", "--audit-log", auditLog, "--format", "json", ...extraArgs];
      const stdout = await new Promise((resolveRun, reject) => {
        const extra = Object.fromEntries((PASS_THROUGH[spec.provider] ?? []).filter((name) => env[name]).map((name) => [name, env[name]]));
        const child = spawn(process.execPath, args, { env: { PATH: env.PATH, HOME: env.HOME, ...extra, [spec.apiKeyEnv]: key }, signal, windowsHide: true });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => { if (out.length < 1_000_000) out += chunk; });
        child.stderr.on("data", (chunk) => { if (err.length < 4000) err += chunk; });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 || out.trim().startsWith("{") ? resolveRun(out) : reject(new Error(`atlas code exited ${code}: ${err.split(key).join("[redacted]").slice(0, 300)}`))));
      });
      const receipt = JSON.parse(stdout);
      let audit = { toolErrors: 0, ttftMs: null };
      try { audit = measureAuditLog(await readFile(auditLog, "utf8")); } catch { /* no trace written */ }
      return {
        status: receipt.status, message: receipt.message ?? receipt.summary,
        toolCalls: receipt.toolCalls ?? 0, toolErrors: audit.toolErrors, repairs: Math.max(0, (receipt.verification?.attempts ?? 1) - 1),
        ttftMs: audit.ttftMs, tokens: { input: receipt.inputTokens ?? 0, output: receipt.outputTokens ?? 0 }, costUsd: null,
      };
    } finally { await rm(scratch, { recursive: true, force: true }); }
  };
}
