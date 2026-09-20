import { describeConfirmation, describePlan, InfrastructureError } from "../infrastructure/adapter.mjs";

/**
 * Infrastructure administration, as two deliberate steps.
 *
 * `infrastructure.plan` is a dry run: it reads the current state and returns
 * the exact target, a redacted preview of the change, and whether it can be
 * undone. `infrastructure.apply` needs the operator's approval, bound to that
 * plan's digest — so what is approved is the specific record on the specific
 * zone, not "permission to change DNS".
 *
 * Secret values never pass through the model. The model names a credential
 * *reference*; the vault resolves it at apply time, and the value appears in
 * no argument, plan, receipt or error.
 */
const RESOURCES = ["dns_record", "environment_variable", "repository_secret", "repository_variable"];
const MAX_PLANS = 100;
/** A plan describes state that was read at the time; it goes stale. */
const PLAN_LIFETIME_MS = 15 * 60_000;

export function registerInfrastructureTools(registry, { providers, vault, plans = new Map() }) {
  const need = (name) => {
    const provider = providers?.[name];
    if (!provider) {
      throw new InfrastructureError("PROVIDER_NOT_CONFIGURED", `No ${name} credentials are configured on this machine. Add a scoped token to the Atlas vault first.`);
    }
    return typeof provider === "function" ? provider() : provider;
  };

  registry.register({
    name: "infrastructure.inspect",
    description: "Read the current state of the operator's infrastructure: zones, DNS, Workers, D1, KV, R2, Vercel projects and deployments, or repository settings.",
    capability: "infrastructure.read",
    risk: "low",
    timeoutMs: 60_000,
    maxOutputCharacters: 30_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["provider", "what"],
      properties: {
        provider: { type: "string", enum: ["cloudflare", "vercel", "git_host"] },
        what: { type: "string", enum: ["zones", "dns", "worker", "d1", "kv", "r2", "browser_rendering", "projects", "deployments", "domains", "env", "settings", "variables", "secrets", "workflows"] },
        zoneId: { type: "string", maxLength: 100, default: "" },
        accountId: { type: "string", maxLength: 100, default: "" },
        projectId: { type: "string", maxLength: 100, default: "" },
        name: { type: "string", maxLength: 300, default: "" },
      },
    },
    async execute({ input, signal }) {
      const provider = need(input.provider === "git_host" ? "gitHost" : input.provider);
      const result = await readState(provider, input, signal);
      return JSON.stringify(result);
    },
  });

  registry.register({
    name: "infrastructure.plan",
    description: "Dry-run an infrastructure change. Returns the exact target, a redacted preview, and whether it can be undone. Changes nothing.",
    capability: "infrastructure.read",
    risk: "low",
    timeoutMs: 60_000,
    maxOutputCharacters: 10_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["resource"],
      properties: {
        resource: { type: "string", enum: RESOURCES },
        zoneId: { type: "string", maxLength: 100, default: "" },
        projectId: { type: "string", maxLength: 100, default: "" },
        recordType: { type: "string", enum: ["A", "AAAA", "CNAME", "TXT", "MX"], default: "A" },
        // No whitespace and no control characters: the name is rendered into
        // the plan an operator reads and was previously parsed back out of it.
        name: { type: "string", maxLength: 300, default: "", pattern: "^[A-Za-z0-9_*.@-]*$" },
        content: { type: "string", maxLength: 2_000, default: "" },
        ttl: { type: "integer", minimum: 1, maximum: 86_400, default: 1 },
        proxied: { type: "boolean", default: false },
        // A reference, never a value. The model cannot see what it names.
        valueRef: { type: "string", maxLength: 64, default: "" },
        target: { type: "array", maxItems: 3, items: { type: "string", enum: ["production", "preview", "development"] } },
      },
    },
    async execute({ input, signal }) {
      const plan = await buildFor(input, { need, vault, signal });
      // Bounded and expiring. Planning needs no approval, the map lived for
      // the life of the process, and a plan survived a DENIED approval — so a
      // change the operator refused could be applied later from another
      // session that obtained its own approval.
      const at = Date.now();
      for (const [key, held] of plans) {
        if (at - held.createdAt > PLAN_LIFETIME_MS) plans.delete(key);
      }
      if (plans.size >= MAX_PLANS) {
        for (const key of [...plans.keys()].slice(0, plans.size - MAX_PLANS + 1)) plans.delete(key);
      }
      plans.set(plan.digest, { plan, input, createdAt: at });
      return `${describePlan(plan)}\nPlan: ${plan.digest}\n\nNothing has changed. Call infrastructure.apply with this plan to make it real; the operator must approve it.`;
    },
  });

  registry.register({
    name: "infrastructure.apply",
    description: "Apply a plan from infrastructure.plan. Requires the operator's approval of that exact plan, and verifies the result afterwards.",
    capability: "infrastructure.write",
    risk: "critical",
    timeoutMs: 120_000,
    maxOutputCharacters: 10_000,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      required: ["plan"],
      properties: { plan: { type: "string", minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" } },
    },
    // The approval prompt is built from this, so it names the actual target
    // rather than the tool's generic description. Answering "infrastructure
    // write — apply a plan" from a phone tells the operator nothing about
    // which zone or which key.
    describeForApproval: ({ input }) => {
      const record = plans.get(input.plan);
      return record ? `Apply: ${describePlan(record.plan)}` : `Apply plan ${input.plan.slice(0, 12)} (no longer held; it will be refused).`;
    },
    async execute({ input, signal }) {
      const record = plans.get(input.plan);
      if (record && Date.now() - record.createdAt > PLAN_LIFETIME_MS) {
        plans.delete(input.plan);
        throw new InfrastructureError("PLAN_EXPIRED", "That plan is older than Atlas will apply. Re-plan the change so the preview reflects the current state.");
      }
      // A plan that was never made here cannot be applied, which is what
      // stops an approval being obtained for a plan nobody ever previewed.
      if (!record) throw new InfrastructureError("UNKNOWN_PLAN", "That plan is not known. Run infrastructure.plan first and apply the plan it returns.");
      plans.delete(input.plan);

      const outcome = await applyFor(record, { need, vault, signal });
      if (!outcome.verified) {
        throw new InfrastructureError("NOT_VERIFIED", `The change was sent but could not be confirmed by reading it back. Observed: ${JSON.stringify(outcome.observed ?? null)}`);
      }
      return [
        `Applied: ${record.plan.provider} ${record.plan.operation} ${record.plan.resource}.`,
        `Target: ${record.plan.target}`,
        // What the read-back established, not a blanket "verified": for a
        // secret it can only be that the name is now there.
        describeConfirmation(outcome.confirmation),
        `Observed after the change: ${JSON.stringify(outcome.observed ?? null)}`,
        record.plan.reversible ? "This change can be rolled back through Atlas." : "This change cannot be undone through Atlas.",
      ].join("\n");
    },
  });

  registry.register({
    name: "infrastructure.rollback_deployment",
    description: "Promote an earlier Vercel deployment back to production. Requires approval.",
    capability: "infrastructure.write",
    risk: "critical",
    timeoutMs: 120_000,
    maxOutputCharacters: 4_000,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      required: ["projectId", "deploymentId"],
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 100 },
        deploymentId: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
    async execute({ input, signal }) {
      const result = await need("vercel").rollbackDeployment({ projectId: input.projectId, deploymentId: input.deploymentId, signal });
      if (!result.verified) throw new InfrastructureError("NOT_VERIFIED", "The rollback was requested but the deployment was not observed afterwards.");
      return `Promoted deployment ${input.deploymentId} on ${input.projectId}.`;
    },
  });

  /** Names only. This is how an operator checks what Atlas holds. */
  registry.register({
    name: "infrastructure.list_credentials",
    description: "List the names of credentials available to Atlas. Values are never readable.",
    capability: "infrastructure.read",
    risk: "low",
    timeoutMs: 15_000,
    maxOutputCharacters: 4_000,
    requiresApproval: false,
    inputSchema: { type: "object", required: [], properties: {} },
    async execute() {
      const entries = await vault.list();
      return entries.length > 0
        ? entries.map((entry) => `${entry.name} (in the ${entry.backend} vault)`).join("\n")
        : "No credentials are stored yet.";
    },
  });

  return registry;
}

async function readState(provider, input, signal) {
  switch (input.what) {
    case "zones": return provider.listZones({ signal });
    case "dns": return provider.listDnsRecords({ zoneId: requireField(input.zoneId, "zoneId"), name: input.name || null, signal });
    case "worker": return provider.workerStatus({ accountId: requireField(input.accountId, "accountId"), scriptName: requireField(input.name, "name"), signal });
    case "d1": return provider.d1Status({ accountId: requireField(input.accountId, "accountId"), signal });
    case "kv": return provider.kvNamespaces({ accountId: requireField(input.accountId, "accountId"), signal });
    case "r2": return provider.r2Buckets({ accountId: requireField(input.accountId, "accountId"), signal });
    case "browser_rendering": return provider.browserRenderingStatus({ accountId: requireField(input.accountId, "accountId"), signal });
    case "projects": return provider.listProjects({ signal });
    case "deployments": return provider.listDeployments({ projectId: requireField(input.projectId, "projectId"), signal });
    case "domains": return provider.listDomains({ projectId: requireField(input.projectId, "projectId"), signal });
    case "env": return provider.listEnvironmentVariables({ projectId: requireField(input.projectId, "projectId"), signal });
    case "settings": return provider.settings({ signal });
    case "variables": return provider.listVariables({ signal });
    case "secrets": return provider.listSecrets({ signal });
    case "workflows": return provider.listWorkflows({ signal });
    default: throw new InfrastructureError("UNSUPPORTED", `'${input.what}' is not readable on this provider.`);
  }
}

async function buildFor(input, { need, vault, signal }) {
  if (input.resource === "dns_record") {
    return need("cloudflare").planDnsRecord({
      zoneId: requireField(input.zoneId, "zoneId"),
      type: input.recordType,
      name: requireField(input.name, "name"),
      content: requireField(input.content, "content"),
      ttl: input.ttl,
      proxied: input.proxied,
      signal,
    });
  }
  if (input.resource === "repository_variable") {
    // A repository variable is NOT a secret — its value is readable by anyone
    // with repository access, and the plan therefore shows it in the clear.
    // That makes a vault reference catastrophic here: resolving one turned
    // this unapproved, low-risk "dry run" into a generic vault-read primitive
    // that printed any stored credential straight into the model's context.
    // A variable takes a literal value and nothing else.
    if (input.valueRef) {
      throw new InfrastructureError(
        "REFERENCE_NOT_ALLOWED",
        "A repository variable is not secret — its value is visible to anyone who can read the repository — so it cannot be set from the credential vault. Pass the literal value in `content`, or use resource 'repository_secret'.",
      );
    }
    return need("gitHost").planVariable({ name: requireField(input.name, "name"), value: requireField(input.content, "content"), signal });
  }

  const value = await resolveSecret(vault, input.valueRef);
  if (input.resource === "environment_variable") {
    return need("vercel").planEnvironmentVariable({
      projectId: requireField(input.projectId, "projectId"),
      key: requireField(input.name, "name"),
      value,
      target: input.target?.length ? input.target : ["production"],
      signal,
    });
  }
  return need("gitHost").planSecret({ name: requireField(input.name, "name"), value, signal });
}

async function applyFor(record, { need, vault, signal }) {
  const { plan, input } = record;
  if (plan.resource === "dns_record") {
    return need("cloudflare").applyDnsRecord({ zoneId: input.zoneId, plan, signal });
  }
  if (plan.resource === "repository_variable") {
    // Literal only, for the same reason as above.
    return need("gitHost").applyVariable({ name: plan.after.name, value: input.content, signal });
  }

  const value = await resolveSecret(vault, input.valueRef);
  if (plan.resource === "environment_variable") {
    return need("vercel").applyEnvironmentVariable({ projectId: input.projectId, plan, value, signal });
  }
  return need("gitHost").applySecret({ name: plan.after.name, value, signal });
}

async function resolveSecret(vault, reference) {
  if (!reference) throw new InfrastructureError("MISSING_REFERENCE", "This change needs a credential reference (valueRef). Atlas never takes a secret value as an argument.");
  const value = await vault.get(reference);
  if (value === null) throw new InfrastructureError("UNKNOWN_REFERENCE", `No credential named '${reference}' is stored. Add it to the Atlas vault first.`);
  return value;
}

function requireField(value, name) {
  if (!value) throw new InfrastructureError("MISSING_FIELD", `${name} is required for this operation.`);
  return value;
}
