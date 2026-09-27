import { createHash } from "node:crypto";
import { buildPlan, createApiClient, InfrastructureError, redactValue } from "./adapter.mjs";

const MAX_STATIC_BYTES = 25 * 1024 * 1024;

/**
 * Vercel: projects, deployments, domains, and encrypted environment
 * variables.
 *
 * Environment variables are the reason this adapter is careful. A value goes
 * in once and is never read back out — Vercel will decrypt on request and
 * Atlas deliberately does not ask. Plans and receipts carry the variable's
 * name, target environment, and the shape of its value, never the value.
 */
const ROOT = "https://api.vercel.com";

export function createVercelAdapter({ token, teamId = null, fetchImpl = fetch }) {
  if (!token) throw new InfrastructureError("NO_CREDENTIAL", "A Vercel API token is required.");
  const call = createApiClient({ root: ROOT, headers: { authorization: `Bearer ${token}` }, fetchImpl });
  const scope = teamId ? { teamId } : {};

  return {
    provider: "vercel",

    async listProjects({ signal } = {}) {
      const payload = await call("/v9/projects", { signal, query: { ...scope, limit: 50 } });
      return (payload?.projects ?? []).map((project) => ({ id: project.id, name: project.name, framework: project.framework ?? null }));
    },

    async listDeployments({ projectId, signal }) {
      const payload = await call("/v6/deployments", { signal, query: { ...scope, projectId, limit: 20 } });
      return (payload?.deployments ?? []).map((deployment) => ({
        uid: deployment.uid,
        state: deployment.state ?? deployment.readyState ?? "unknown",
        target: deployment.target ?? "preview",
        url: deployment.url ? `https://${deployment.url}` : null,
        createdAt: deployment.created ?? null,
      }));
    },

    async listDomains({ projectId, signal }) {
      const payload = await call(`/v9/projects/${projectId}/domains`, { signal, query: scope });
      return (payload?.domains ?? []).map((domain) => ({ name: domain.name, verified: Boolean(domain.verified) }));
    },

    /** Names, targets, and value *shape*. Never a decrypted value. */
    async listEnvironmentVariables({ projectId, signal }) {
      const payload = await call(`/v10/projects/${projectId}/env`, { signal, query: { ...scope, decrypt: "false" } });
      return (payload?.envs ?? []).map((entry) => ({
        id: entry.id,
        key: entry.key,
        target: entry.target ?? [],
        type: entry.type ?? "encrypted",
        updatedAt: entry.updatedAt ?? null,
      }));
    },

    async planEnvironmentVariable({ projectId, key, value, target = ["production"], signal }) {
      const existing = (await this.listEnvironmentVariables({ projectId, signal })).find(
        (entry) => entry.key === key && target.every((scopeName) => entry.target.includes(scopeName)),
      );
      const production = target.includes("production");
      return buildPlan({
        provider: "vercel",
        operation: existing ? "rotate" : "create",
        resource: "environment_variable",
        target: `${key} on ${projectId} (${target.join(", ")})`,
        before: existing ? { key: existing.key, target: existing.target, value: "(unchanged, never read back)" } : null,
        after: { key, target, value: redactValue(value) },
        // Vercel keeps no previous value to restore, so this is one-way.
        reversible: false,
        notes: [
          "The value is written once and never read back by Atlas.",
          production ? "This is a production variable; a redeploy is needed before it takes effect." : "This affects preview or development builds only.",
        ],
      });
    },

    async applyEnvironmentVariable({ projectId, plan, value, signal }) {
      const key = plan.after.key;
      const target = plan.after.target;
      const existing = (await this.listEnvironmentVariables({ projectId, signal })).find(
        (entry) => entry.key === key && target.every((scopeName) => entry.target.includes(scopeName)),
      );
      if (existing) {
        await call(`/v9/projects/${projectId}/env/${existing.id}`, { method: "PATCH", body: { value, target }, signal, query: scope });
      } else {
        await call(`/v10/projects/${projectId}/env`, { method: "POST", body: { key, value, target, type: "encrypted" }, signal, query: scope });
      }
      // Verification is existence and metadata, because reading the value
      // back is exactly what this adapter refuses to do.
      const after = (await this.listEnvironmentVariables({ projectId, signal })).find(
        (entry) => entry.key === key && target.every((scopeName) => entry.target.includes(scopeName)),
      );
      return { verified: Boolean(after), observed: after ?? null };
    },

    async deleteEnvironmentVariable({ projectId, id, signal }) {
      await call(`/v9/projects/${projectId}/env/${id}`, { method: "DELETE", signal, query: scope });
      const remaining = await this.listEnvironmentVariables({ projectId, signal });
      return { verified: !remaining.some((entry) => entry.id === id) };
    },

    /**
     * Plans a static deployment of already-built files (the Genesis
     * static-site template's dist/). The plan's digest covers every file's
     * content hash, so the approval is for exactly these bytes.
     */
    planStaticDeployment({ name, files, target = "preview" }) {
      if (!/^[a-z0-9][a-z0-9-]{0,99}$/u.test(name ?? "")) throw new InfrastructureError("BAD_NAME", "A Vercel project name uses lowercase letters, numbers and dashes.");
      if (!["preview", "production"].includes(target)) throw new InfrastructureError("BAD_TARGET", "Target is preview or production.");
      if (!files?.length) throw new InfrastructureError("NO_FILES", "There is nothing to deploy; build the site first.");
      const bytes = files.reduce((sum, file) => sum + file.data.length, 0);
      if (bytes > MAX_STATIC_BYTES) throw new InfrastructureError("TOO_LARGE", `The site is ${Math.round(bytes / 1024)} KiB; Atlas deploys static sites up to ${MAX_STATIC_BYTES / 1024 / 1024} MiB.`);
      return buildPlan({
        provider: "vercel",
        operation: "create",
        resource: "static_deployment",
        target: `${name} (${target})`,
        before: null,
        after: { name, target, files: files.map((file) => ({ file: file.file, sha1: createHash("sha1").update(file.data).digest("hex"), bytes: file.data.length })) },
        reversible: true,
        notes: [
          target === "production" ? "This publishes the site at the project's production address." : "A preview deployment gets its own public, hard-to-guess address.",
          "Anyone with the address can see the site. Vercel keeps earlier deployments, so this can be rolled back.",
        ],
      });
    },
    async applyStaticDeployment({ plan, files, signal, pollMs = 2_000, timeoutMs = 180_000 }) {
      // The files must be exactly the approved ones.
      const approved = new Map(plan.after.files.map((file) => [file.file, file.sha1]));
      if (files.length !== approved.size || files.some((file) => approved.get(file.file) !== createHash("sha1").update(file.data).digest("hex"))) {
        throw new InfrastructureError("CHANGED_UNDERNEATH", "The site changed after this deployment was approved; plan it again.");
      }
      const created = await call("/v13/deployments", {
        method: "POST",
        signal,
        query: { ...scope, skipAutoDetectionConfirmation: 1 },
        body: {
          name: plan.after.name,
          target: plan.after.target === "production" ? "production" : undefined,
          files: files.map((file) => ({ file: file.file, data: file.data.toString("base64"), encoding: "base64" })),
          projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
        },
      });
      const id = created?.id;
      if (!id) throw new InfrastructureError("REQUEST_FAILED", "Vercel did not return a deployment id.");
      const deadline = Date.now() + timeoutMs;
      let observed = created;
      while (Date.now() < deadline) {
        observed = await call(`/v13/deployments/${id}`, { signal, query: scope });
        const state = observed?.readyState ?? observed?.state;
        if (state === "READY" || state === "ERROR" || state === "CANCELED") break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      const state = observed?.readyState ?? observed?.state ?? "unknown";
      return { verified: state === "READY", observed: { id, state, url: observed?.url ? `https://${observed.url}` : null, target: plan.after.target } };
    },
    /** Vercel supports promoting an older deployment, which is a real rollback. */
    async rollbackDeployment({ projectId, deploymentId, signal }) {
      await call(`/v9/projects/${projectId}/promote/${deploymentId}`, { method: "POST", signal, query: scope });
      const deployments = await this.listDeployments({ projectId, signal });
      return { verified: deployments.some((deployment) => deployment.uid === deploymentId), deploymentId };
    },
  };
}
