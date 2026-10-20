import { join } from "node:path";
import { AgentFamilyRegistry } from "./family/family-graph.mjs";
import { seedFamilies } from "./family/default-families.mjs";
import { ScopedMemoryStore } from "./memory/memory-store.mjs";
import { ModelCapabilityRegistry, profilesFromRoutes } from "./models/capabilities.mjs";
import { CapabilityRouter } from "./models/router.mjs";
import { AuthorizedToolExecutor } from "./executor.mjs";
import { PolicyEngine } from "./policy.mjs";
import { repositoryPlatformTools } from "./adapters.mjs";
import { WorkforceCoordinator } from "./workforce.mjs";
import { LOCAL_TENANT_ID } from "./dashboard.mjs";
import { createModelClient } from "../agent/model-client.mjs";
import { redactSecrets } from "./memory/redaction.mjs";

/** Initial production adapter: confined repository reads, no external mutation. */
export function createWorkforceRuntime({ store, dataDirectory, repository, model, endpoint, modelClientFactory = createModelClient }) {
  const registry = new AgentFamilyRegistry(join(dataDirectory, "workforce.sqlite"));
  const memory = new ScopedMemoryStore(join(dataDirectory, "workforce-memory.sqlite"));
  const budget = { toolCalls: 1000, wallTimeMs: 36_000_000, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicroUsd: 0 };
  const permissions = ["repository.list", "repository.read", "repository.search", "model.respond"];
  const tree = { name: "Atlas Execution Workforce", role: "root", family: "atlas", budget,
    families: [{ name: "Engineering Coordinator", role: "parent", family: "engineering", children: [
      { name: "Engineering Worker", role: "engineering", permissions, persistent: true, budget: { ...budget, toolCalls: 200, wallTimeMs: 1_800_000, inputTokens: 100_000, outputTokens: 100_000 } },
      { name: "Research Worker", role: "research", permissions, persistent: true, budget: { ...budget, toolCalls: 200, wallTimeMs: 1_800_000, inputTokens: 100_000, outputTokens: 100_000 } },
    ] }], oversight: [{ name: "Quality Reviewer", role: "reviewer", relationship: "reviews", permissions: [] }] };
  // seedFamilies computes reservation budgets for parents/oversight. Use its
  // existing conservative allocation rather than granting runtime authority.
  tree.budget = { toolCalls: 20_000, wallTimeMs: 360_000_000, inputTokens: 50_000_000, outputTokens: 12_000_000, costMicroUsd: 250_000_000 };
  const workforce = seedFamilies(registry, LOCAL_TENANT_ID, { tree });
  const models = new ModelCapabilityRegistry(profilesFromRoutes([{ model, endpoint, task: "coding" }]));
  const router = new CapabilityRouter(models);
  const executor = new AuthorizedToolExecutor({ store, policy: new PolicyEngine({ version: "workforce.1", rules: [] }) });
  for (const { tool, timeoutMs } of repositoryPlatformTools({ repository })) executor.register(tool, { timeoutMs });
  executor.register({ name: "model.respond", description: "Produce a bounded response using the routed local model.", risk: "read",
    inputSchema: { type: "object", additionalProperties: false, required: ["prompt", "modelProfile"], properties: {
      prompt: { type: "string", minLength: 1, maxLength: 16_000 }, modelProfile: { type: "string", minLength: 1 },
      maxOutputTokens: { type: "integer", minimum: 1, maximum: 4096 } } },
    async execute(input, { signal }) {
      const profile = models.effective(input.modelProfile);
      // Hosted inference needs operator-supplied pricing and credential
      // adapters. Unknown prices must not masquerade as free execution.
      if (!profile.local) throw new Error("This workforce adapter supports local inference only.");
      const prompt = redactSecrets(input.prompt).text;
      let text = ""; let usage;
      for await (const event of modelClientFactory({ baseUrl: profile.endpoint }).stream({ model: profile.model,
        messages: [{ role: "user", content: prompt }], maxOutputTokens: input.maxOutputTokens ?? 256, signal })) {
        if (event.type === "text") {
          text += event.delta;
          if (text.length > 64_000) throw new Error("Model response exceeded the output bound.");
        }
        if (event.type === "done") usage = event.usage;
      }
      return { output: redactSecrets(text).text,
        evidence: [{ kind: "model_response", profileId: profile.id, provider: profile.provider }],
        usage: { inputTokens: usage?.prompt_tokens ?? Buffer.byteLength(prompt, "utf8") + 512,
          outputTokens: usage?.completion_tokens ?? input.maxOutputTokens ?? 256, costMicroUsd: 0 } };
    },
  });
  const coordinator = new WorkforceCoordinator({ store, registry, memory, router, executor });
  coordinator.recover(LOCAL_TENANT_ID);
  return { coordinator, registry, memory, workforce, repository, tools: executor.list(),
    close() { registry.close(); memory.close(); } };
}

export function createWorkforceRoutes(runtime) {
  return {
    async handle(request, response, identity) {
      const path = new URL(request.url, "http://local.atlas").pathname;
      if (!path.startsWith("/v1/workforce")) return false;
      const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); return true; };
      if (identity.role !== "admin") return send(403, { message: "Only the local owner can access workforce execution." });
      if (request.method === "GET" && path === "/v1/workforce") return send(200, { agentDetails: runtime.registry.listAgents(LOCAL_TENANT_ID), tools: runtime.tools, repository: runtime.repository, ...runtime.workforce });
      if (request.method === "GET" && path === "/v1/workforce/runs") {
        const limit = Number(new URL(request.url, "http://local.atlas").searchParams.get("limit") ?? 50);
        return send(200, { runs: runtime.coordinator.list(LOCAL_TENANT_ID, { limit }) });
      }
      const match = /^\/v1\/workforce\/runs\/(tsk_[0-9a-f]{32})(\/(?:resume|cancel))?$/.exec(path);
      if (match && request.method === "GET" && !match[2]) {
        const run = runtime.coordinator.get(LOCAL_TENANT_ID, match[1]);
        return run ? send(200, { run }) : send(404, { message: "Run not found." });
      }
      if (request.method !== "POST") return send(405, { message: "Unsupported workforce operation." });
      if (path !== "/v1/workforce/runs" && !match?.[2]) return send(404, { message: "Workforce route not found." });
      let raw = "";
      try {
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 64 * 1024) return send(413, { message: "Workforce plan exceeds 64 KiB." });
          raw += chunk.toString("utf8");
        }
        const body = raw ? JSON.parse(raw) : {};
        const run = match ? runtime.coordinator.get(LOCAL_TENANT_ID, match[1]) : runtime.coordinator.create({ ...body, tenantId: LOCAL_TENANT_ID, userId: "local-owner" });
        if (!run) return send(404, { message: "Run not found." });
        if (match?.[2] === "/cancel") return send(200, { run: runtime.coordinator.cancel(LOCAL_TENANT_ID, run.taskId) });
        // Status/artifacts are available from the authenticated GET/dashboard.
        // HTTP intake never waits for a long-lived execution to finish.
        void runtime.coordinator.resume(LOCAL_TENANT_ID, run.taskId).catch(() => {});
        return send(202, { taskId: run.taskId });
      } catch (error) { return send(400, { message: String(error.message).slice(0, 500) }); }
    },
  };
}
