import { buildPlan, CONFIRMATION, createApiClient, InfrastructureError, redactValue } from "./adapter.mjs";

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
      // Presence and metadata only: reading an encrypted environment value
      // back is exactly what this adapter refuses to do, so the read-back
      // cannot tell a correct write from one that stored the wrong value.
      const after = (await this.listEnvironmentVariables({ projectId, signal })).find(
        (entry) => entry.key === key && target.every((scopeName) => entry.target.includes(scopeName)),
      );
      return { verified: Boolean(after), confirmation: after ? CONFIRMATION.PRESENCE : null, observed: after ?? null };
    },

    async deleteEnvironmentVariable({ projectId, id, signal }) {
      await call(`/v9/projects/${projectId}/env/${id}`, { method: "DELETE", signal, query: scope });
      const remaining = await this.listEnvironmentVariables({ projectId, signal });
      const gone = !remaining.some((entry) => entry.id === id);
      return { verified: gone, confirmation: gone ? CONFIRMATION.ABSENCE : null };
    },

    /** Vercel supports promoting an older deployment, which is a real rollback. */
    async rollbackDeployment({ projectId, deploymentId, signal }) {
      await call(`/v9/projects/${projectId}/promote/${deploymentId}`, { method: "POST", signal, query: scope });
      const deployments = await this.listDeployments({ projectId, signal });
      const present = deployments.some((deployment) => deployment.uid === deploymentId);
      return { verified: present, confirmation: present ? CONFIRMATION.PRESENCE : null, deploymentId };
    },
  };
}
