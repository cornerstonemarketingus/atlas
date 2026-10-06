import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { freeLocalChoices } from "./catalog.mjs";
import { ModelManagerError } from "./manager.mjs";
import { createModelClient } from "../model-client.mjs";
import { ModelRequestError } from "../model-client.mjs";
import { createGateway } from "../../../../../scripts/local/model-gateway.mjs";
import { ModelCapabilityRegistry } from "../../platform/models/capabilities.mjs";
import { runCapabilitySuite } from "../../platform/models/capability-suite.mjs";
import { runCommand } from "../tools/process.mjs";
import { estimateTokens } from "./context-fit.mjs";
import { probeCodingAgent } from "./coding-probe.mjs";

/** Owns the guided lifecycle; runtime operations stay on the ModelManager adapter.
 * Nothing returned by this service contains a gateway credential.
 */
export class FreeLocalSetup {
  constructor({ manager, planStore, vault, detectHardware, port = 11435, gatewayFactory = createGateway, runCommandImpl = runCommand, fetchImpl = fetch, codingProbe = probeCodingAgent }) {
    Object.assign(this, { manager, planStore, vault, detectHardware, port, gatewayFactory, runCommandImpl, fetchImpl, codingProbe });
    this.gateway = null;
    this.job = { state: "idle", step: "Check computer" };
    this.promise = null;
    this.connection = { state: "disconnected", message: "Hosted Atlas is not connected." };
    this.tools = [];
  }

  async startup(enabled) {
    if (process.platform !== "win32") throw new ModelManagerError("INVALID_PLAN", "Automatic startup is currently supported on Windows. Start Atlas using your operating system's user service manager.");
    const script = fileURLToPath(new URL("../../../../../scripts/windows/Enable-AtlasStartup.ps1", import.meta.url));
    const result = await this.runCommandImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, ...(enabled ? [] : ["-Disable"])], { timeoutMs: 30000 });
    if (!result.ok) throw new ModelManagerError("START_FAILED", "Windows could not register startup. Check the Task Scheduler permissions for your Windows account.");
    return { enabled, scope: "current-windows-user", startsAt: "sign-in" };
  }

  async overview() {
    const [hardware, runtime] = await Promise.all([this.detectHardware(), this.manager.status()]);
    const applied = this.planStore.read();
    const installed = runtime.installed.map((entry) => entry.tag);
    return { choices: freeLocalChoices({ ...hardware, requiredContextTokens: estimateTokens(JSON.stringify(this.tools).length) + 2304 }, installed), job: { ...this.job },
      online: runtime.reachable && Boolean(this.gateway) && Boolean(applied?.freeLocal) && installed.includes(applied.coder.tag),
      selected: applied?.freeLocal ? applied.coder : null, cloudFallback: applied?.cloudFallback === true,
      scope: "this-computer", remoteConnected: false, connection: { ...this.connection } };
  }

  setFallback(enabled) {
    const plan = this.planStore.read();
    if (!plan?.freeLocal) throw new ModelManagerError("INVALID_PLAN", "Set up local AI before changing fallback.");
    const applied = this.planStore.write({ ...plan, cloudFallback: enabled === true });
    return { enabled: applied.cloudFallback, message: enabled ? "Configured fallback is on. Cloud providers may charge when local AI is unavailable." : "Cloud fallback is off. No automatic paid AI usage." };
  }

  /** Trusted child-process configuration; never serialized into API responses or arguments. */
  async coderConfiguration() {
    const plan = this.planStore.read();
    if (!plan && existsSync(this.planStore.path)) throw new ModelRequestError("MODEL_INVALID_INPUT", "The saved model plan is invalid. Review Models.");
    if (!plan?.freeLocal) return undefined;
    const apiKey = await this.vault.get("FREE_LOCAL_GATEWAY_KEY");
    if (!apiKey || !this.gateway || !await this.manager.reachable()) throw new ModelRequestError("MODEL_UNREACHABLE", "Local AI is offline. Retry setup before starting a coding run.");
    if (!plan.capabilities?.codingAgent) throw new ModelRequestError("MODEL_INVALID_INPUT", "This model has not passed the actual coding agent repair test.");
    return { model: plan.coder.tag, context: plan.coder.context, apiKey, baseUrl: `http://127.0.0.1:${this.gateway.address().port}/v1/` };
  }

  /** Inference-only Funnel; never publish the daemon or Ollama management port. */
  async connectHosted() {
    if (!this.gateway || !this.planStore.read()?.freeLocal) throw new ModelManagerError("START_FAILED", "Finish local AI setup first.");
    const command = process.platform === "win32" ? "C:\\Program Files\\Tailscale\\tailscale.exe" : "tailscale";
    const status = await this.runCommandImpl(command, ["status", "--json"], { timeoutMs: 8000 });
    let state;
    try { state = JSON.parse(status.stdout); } catch {
      this.connection = { state: "needs-install", message: "Install the official Tailscale connection helper, then sign in from its taskbar icon. Windows may ask for administrator approval." };
      return { ...this.connection };
    }
    if (state.BackendState !== "Running") {
      this.connection = { state: "needs-sign-in", message: "Sign in to Tailscale from its taskbar icon on this computer, then retry Connect hosted Atlas." };
      return { ...this.connection };
    }
    const hostname = String(state.Self?.DNSName ?? "").replace(/\.$/u, "");
    if (!/^[a-z0-9][a-z0-9.-]*\.ts\.net$/u.test(hostname)) throw new ModelManagerError("START_FAILED", "The secure connection helper did not provide a valid HTTPS address.");
    const before = await this.runCommandImpl(command, ["serve", "status", "--json"], { timeoutMs: 8000 });
    let serving;
    try { serving = JSON.parse(before.stdout); } catch { throw new ModelManagerError("START_FAILED", "Could not check existing secure connections. Nothing was exposed."); }
    // Preserve the existing private device transport. Do not overwrite its listener.
    const occupied = serving.TCP?.["443"];
    const gatewayPort = this.gateway.address().port;
    if (occupied && !JSON.stringify(serving).includes(`127.0.0.1:${gatewayPort}`)) throw new ModelManagerError("START_FAILED", "This computer already has a secure connection on port 443. Atlas left it unchanged; use an inference-only HTTPS proxy in Advanced setup.");
    const result = await this.runCommandImpl(command, ["funnel", "--bg", "--https=443", `http://127.0.0.1:${gatewayPort}`], { timeoutMs: 30000 });
    if (!result.ok) {
      this.connection = { state: "needs-authorization", message: "Allow Funnel for this device in Tailscale, then retry. Only the authenticated Atlas inference gateway will be shared." };
      return { ...this.connection };
    }
    const credential = await this.vault.get("FREE_LOCAL_GATEWAY_KEY");
    try {
      const response = await this.fetchImpl(`https://${hostname}/v1/health`, { headers: { authorization: `Bearer ${credential}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok || (await response.json()).provider !== "local") throw new Error("health");
    } catch { throw new ModelManagerError("START_FAILED", "The secure HTTPS connection did not pass its authenticated health test. Hosted Atlas has not been connected."); }
    this.connection = { state: "gateway-ready", endpoint: `https://${hostname}/v1/`, message: "Secure inference gateway verified. Hosted provider registration still needs deployment authorization." };
    return { ...this.connection };
  }

  resume() {
    const applied = this.planStore.read();
    if (!applied?.freeLocal || this.promise) return;
    if (!applied.capabilities?.codingAgent) {
      this.job = { state: "failed", model: applied.coder.tag, code: "CAPABILITY_FAILED", step: "Verification required", message: "This saved model needs the current coding repair test. Choose Recommended and retry setup." };
      return;
    }
    this.job = { state: "running", step: "Restoring local AI" };
    this.promise = this.#setup("balanced", applied.coder).catch((error) => {
      this.job = { state: "failed", model: this.job.model, step: "Restoring local AI", code: error.code ?? "SETUP_FAILED", message: "Local AI could not recover. Open Models and retry; your saved fallback preference still applies." };
    }).finally(() => { this.promise = null; });
  }

  start(choice = "balanced") {
    if (!["best", "balanced", "lightweight"].includes(choice)) throw new ModelManagerError("INVALID_PLAN", "Choose Recommended, Faster or Higher quality.");
    if (this.promise) return { ...this.job };
    this.job = { state: "running", step: "Checking computer" };
    this.promise = this.#setup(choice).catch((error) => {
      this.job = { state: "failed", model: this.job.model, step: this.job.step, code: error.code ?? "SETUP_FAILED", message: error instanceof ModelManagerError ? error.message : "Setup could not finish. Retry or check local diagnostics." };
    }).finally(() => { this.promise = null; });
    return { ...this.job };
  }

  async #setup(choice, restored = null) {
    const { choices } = await this.overview();
    const selected = restored ? Object.values(choices).find((entry) => entry?.tag === restored.tag && entry.context === restored.context) : choices[choice];
    if (!selected) throw new ModelManagerError("INVALID_PLAN", "No coding model fits this computer with enough memory and disk headroom.");
    this.job.model = selected.tag;
    const before = await this.manager.status();
    if (before.binary === "missing") {
      this.job.step = "Installing local AI — approve Windows if prompted";
      await this.manager.installRuntime();
    }
    this.job.step = "Starting local AI";
    await this.manager.ensureServer({ contextLength: selected.context });
    if (!selected.installed) {
      const hardware = await this.detectHardware();
      if (hardware.freeDiskGiB == null || hardware.freeDiskGiB < selected.downloadGB * 1.2 + 1) throw new ModelManagerError("INVALID_PLAN", "Atlas could not confirm enough disk space for this download.");
      this.job.step = "Downloading model";
      const download = this.manager.install(selected.tag);
      await download.promise;
      if (download.state !== "done") throw new ModelManagerError("PULL_FAILED", "The model download failed. Retry from Models.");
    }
    this.job.step = "Checking available memory";
    const hardware = await this.detectHardware();
    const runtime = await this.manager.status();
    const reclaimable = runtime.loaded.reduce((sum, entry) => sum + (entry.memoryGB ?? 0) / 1.074, 0);
    if (hardware.accelerator === "cpu" && hardware.freeMemoryGiB + reclaimable < selected.memoryGiB + 0.5) throw new ModelManagerError("INSUFFICIENT_MEMORY", `Close other applications and retry. This model needs about ${selected.memoryGiB} GB plus working memory.`);
    this.job.step = "Loading model";
    await this.manager.warm(selected.tag, selected.context);
    this.job.step = "Securing connection";
    await this.close();
    let credential = await this.vault.get("FREE_LOCAL_GATEWAY_KEY");
    if (!credential) {
      credential = randomBytes(32).toString("base64url");
      await this.vault.set("FREE_LOCAL_GATEWAY_KEY", credential);
    }
    const gateway = this.gatewayFactory({ token: credential, model: selected.tag, maxTokens: 2048, queueWaitMs: 1500, queueLimit: 2, defaultReasoningEffort: selected.reasoningEffort });
    gateway.listen(this.port, "127.0.0.1");
    try { await once(gateway, "listening"); } catch { gateway.close(); throw new ModelManagerError("START_FAILED", "The secure local AI connection could not start. Another Atlas instance may already be running."); }
    this.gateway = gateway;
    this.job.step = "Testing model";
    try {
      const client = createModelClient({ baseUrl: `http://127.0.0.1:${gateway.address().port}/v1/`, apiKey: credential });
      let text = "";
      const started = Date.now();
      for await (const event of client.stream({ model: selected.tag, messages: [{ role: "user", content: "Reply with the word READY. No tool call is needed." }], tools: this.tools, maxOutputTokens: 32, signal: AbortSignal.timeout(120000) })) {
        if (event.type === "text") text += event.delta;
      }
      if (!text.trim()) throw new ModelManagerError("WARM_FAILED", "The model returned no text. Setup is not complete.");
      this.job.step = "Testing coding agent capabilities";
      const registry = new ModelCapabilityRegistry();
      const id = `ollama:${selected.tag}`;
      registry.register({ id, provider: "ollama", model: selected.tag, endpoint: "http://127.0.0.1:11434", local: true,
        capabilities: { contextTokens: selected.context, toolCalls: false, structuredOutput: false, vision: false }, costPerMTokIn: 0, costPerMTokOut: 0 });
      const bounded = { stream: (request) => client.stream({ ...request, maxOutputTokens: 128, signal: AbortSignal.timeout(120000) }) };
      const measured = await runCapabilitySuite(bounded, id, { registry, model: selected.tag, contextSizes: [1024] });
      if (!measured.measured.capabilities.toolCalls) throw new ModelManagerError("CAPABILITY_FAILED", "This model did not pass Atlas's agent tool test. Try another model; cloud AI was not used.");
      this.job.step = "Verifying a real coding repair";
      const coding = await this.codingProbe({ model: selected.tag, context: selected.context, baseUrl: `http://127.0.0.1:${gateway.address().port}/v1/`, apiKey: credential });
      if (!coding.passed) throw new ModelManagerError("CAPABILITY_FAILED", "This model did not complete Atlas's coding repair. Try a higher-quality model; cloud AI was not used.");
      measured.measured.capabilities.codingAgent = true;
      const cloudFallback = this.planStore.read()?.cloudFallback === true;
      this.planStore.write({ coder: { tag: selected.tag, context: selected.context }, fast: { tag: selected.tag, context: selected.context }, freeLocal: true, cloudFallback, capabilities: measured.measured.capabilities });
      this.job = { state: "ready", step: "Your free AI is ready", model: selected.tag, latencyMs: Date.now() - started, provider: "local", cloudFallback, capabilities: measured.measured.capabilities };
    } catch (error) { await this.close(); throw error; }
  }

  async close() {
    if (!this.gateway) return;
    const server = this.gateway;
    this.gateway = null;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  /** Uses the existing client contract, enforcing the applied local-only choice. */
  client(fallback, onRoute = () => {}) {
    const setup = this;
    return {
      endpoint: fallback.endpoint,
      async *stream(request) {
        const plan = setup.planStore.read();
        if (!plan && existsSync(setup.planStore.path)) throw new ModelRequestError("MODEL_INVALID_INPUT", "The saved model plan is invalid. Review Models before continuing.");
        if (!plan?.freeLocal) { yield* fallback.stream(request); return; }
        if (estimateTokens(JSON.stringify(request.messages).length + JSON.stringify(request.tools ?? []).length) + (request.maxOutputTokens ?? 2048) > plan.coder.context) throw new ModelRequestError("MODEL_INVALID_INPUT", "This request exceeds your local model's configured context. Start a shorter conversation or choose a larger local model.");
        let started = false;
        try {
          if (!(await setup.manager.reachable())) throw new ModelRequestError("MODEL_UNREACHABLE", "Your local AI computer is offline. Turn it on or retry.");
          const credential = await setup.vault.get("FREE_LOCAL_GATEWAY_KEY");
          if (!setup.gateway || !credential) throw new ModelRequestError("MODEL_UNREACHABLE", "Reconnect Free Local AI from Models.");
          const client = createModelClient({ baseUrl: `http://127.0.0.1:${setup.gateway.address().port}/v1/`, apiKey: credential });
          for await (const chunk of client.stream({ ...request, model: plan.coder.tag })) {
            if (!started) { started = true; const route = { provider: "local", model: plan.coder.tag, paid: false }; onRoute(route); request.onRoute?.(route); }
            yield chunk;
          }
        } catch (error) {
          if (started || request.signal?.aborted || ["MODEL_NOT_AUTHORIZED", "MODEL_INVALID_INPUT"].includes(error.code)) throw error;
          if (!plan.cloudFallback) throw new ModelRequestError(error.code ?? "MODEL_UNREACHABLE", `${error.message} Cloud fallback is off.`);
          let actual = null;
          for await (const chunk of fallback.stream({ ...request, onRoute: (route) => { actual = route; } })) {
            if (!started) {
              started = true;
              const endpoint = actual?.endpoint ?? fallback.endpoint;
              const cloud = endpoint && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(endpoint).hostname);
              const route = { provider: cloud ? "cloud" : "local", model: actual?.model ?? request.model, paid: Boolean(cloud), failedOver: true };
              onRoute(route); request.onRoute?.(route);
            }
            yield chunk;
          }
        }
      },
    };
  }
}
