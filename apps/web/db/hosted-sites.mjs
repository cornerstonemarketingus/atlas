// Hosted website projects (apps/web/app/api/genesis/hosted-site.mjs) in the
// genesis_projects table. Plain SQL over the D1 binding, tenant-scoped like
// db/tenancy.mjs; the one exception is `getHostedSiteForPreview`, because a
// preview link is an unguessable capability that must open without signing in.

const COLUMNS = "id, tenant_id AS tenantId, requested_by AS requestedBy, prompt, name, requirements_json AS requirementsJson, status, repository, preview_url AS previewUrl, deployment_url AS deploymentUrl, evidence_json AS evidenceJson, created_at AS createdAt, updated_at AS updatedAt";

function requireScope(scope) {
  if (!scope || !Number.isSafeInteger(scope.tenantId) || typeof scope.principal !== "string" || scope.principal === "") throw new TypeError("A tenant scope ({ tenantId, principal }) is required.");
}

export function hostedSiteStore(d1) {
  return {
    insert: async (row) => {
      await d1.prepare("INSERT INTO genesis_projects (id, tenant_id, requested_by, prompt, name, requirements_json, status, repository, preview_url, deployment_url, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(row.id, row.tenantId, row.requestedBy, row.prompt, row.name, row.requirementsJson, row.status, row.repository, row.previewUrl, row.deploymentUrl, row.evidenceJson, row.createdAt, row.updatedAt).run();
    },
    /** A project the caller's tenant and principal own; anyone else's is indistinguishable from missing. */
    get: async (scope, id) => {
      requireScope(scope);
      return await d1.prepare(`SELECT ${COLUMNS} FROM genesis_projects WHERE id = ? AND tenant_id = ? AND requested_by = ?`).bind(id, scope.tenantId, scope.principal).first();
    },
    /**
     * Replace the site, evidence and timestamp of a project the caller owns, only if
     * it is still at `expectedUpdatedAt` (optimistic concurrency). Returns false when
     * nothing was written: missing, someone else's, not ready, or changed since read.
     */
    update: async (scope, { id, expectedUpdatedAt, name, requirementsJson, evidenceJson, updatedAt }) => {
      requireScope(scope);
      if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt === "") throw new TypeError("expectedUpdatedAt is required.");
      const result = await d1.prepare("UPDATE genesis_projects SET name = ?, requirements_json = ?, evidence_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND requested_by = ? AND updated_at = ? AND status = 'ready'")
        .bind(name, requirementsJson, evidenceJson, updatedAt, id, scope.tenantId, scope.principal, expectedUpdatedAt).run();
      return Number(result?.meta?.changes ?? 0) === 1;
    },
    countSince: async (tenantId, sinceIso) => {
      const count = await d1.prepare("SELECT COUNT(*) AS count FROM genesis_projects WHERE tenant_id = ? AND created_at >= ? AND requirements_json LIKE '%\"kind\":\"hosted-static-site\"%'").bind(tenantId, sinceIso).first("count");
      return Number(count ?? 0);
    },
  };
}

/** The preview route's lookup: by id alone. The caller must check the row is a hosted site. */
export async function getHostedSiteForPreview(d1, id) {
  return await d1.prepare(`SELECT ${COLUMNS} FROM genesis_projects WHERE id = ?`).bind(id).first();
}
