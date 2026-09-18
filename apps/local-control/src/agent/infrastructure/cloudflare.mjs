import { buildPlan, createApiClient, InfrastructureError, redactValue } from "./adapter.mjs";

/**
 * Cloudflare: zones, DNS, Workers, D1, KV, R2, and Browser Rendering.
 *
 * Reads are free. Every write produces a plan first, and the plan is what the
 * operator approves — so the thing approved is the exact record, on the exact
 * zone, with the exact value.
 */
const ROOT = "https://api.cloudflare.com/client/v4";

export function createCloudflareAdapter({ token, fetchImpl = fetch }) {
  if (!token) throw new InfrastructureError("NO_CREDENTIAL", "A Cloudflare API token is required.");
  const call = createApiClient({ root: ROOT, headers: { authorization: `Bearer ${token}` }, fetchImpl });
  const unwrap = (payload) => payload?.result ?? payload;

  return {
    provider: "cloudflare",

    async listZones({ signal } = {}) {
      const zones = unwrap(await call("/zones", { signal, query: { per_page: 50 } })) ?? [];
      return zones.map((zone) => ({ id: zone.id, name: zone.name, status: zone.status }));
    },

    async listDnsRecords({ zoneId, name = null, signal }) {
      const records = unwrap(await call(`/zones/${zoneId}/dns_records`, { signal, query: { per_page: 100, name } })) ?? [];
      return records.map(summarizeRecord);
    },

    /**
     * Plans a DNS change. DNS is the sharpest edge in this whole surface — a
     * wrong record takes a domain off the internet — so the plan always
     * carries the current value, not just the new one.
     */
    async planDnsRecord({ zoneId, type, name, content, ttl = 1, proxied = false, signal }) {
      const existing = (await this.listDnsRecords({ zoneId, name, signal })).find((record) => record.type === type);
      return buildPlan({
        provider: "cloudflare",
        operation: existing ? "update" : "create",
        resource: "dns_record",
        target: `${name} ${type} (zone ${zoneId})`,
        before: existing ? { type: existing.type, content: existing.content, ttl: existing.ttl, proxied: existing.proxied } : null,
        after: { type, content, ttl, proxied },
        reversible: Boolean(existing),
        notes: existing
          ? [`Restoring this means setting ${name} ${type} back to ${existing.content}.`]
          : ["This record does not exist yet; undoing means deleting it."],
      });
    },

    async applyDnsRecord({ zoneId, plan, signal }) {
      const body = { type: plan.after.type, name: plan.target.split(" ")[0], content: plan.after.content, ttl: plan.after.ttl, proxied: plan.after.proxied };
      if (plan.operation === "create") {
        unwrap(await call(`/zones/${zoneId}/dns_records`, { method: "POST", body, signal }));
      } else {
        const existing = (await this.listDnsRecords({ zoneId, name: body.name, signal })).find((record) => record.type === body.type);
        if (!existing) throw new InfrastructureError("CHANGED_UNDERNEATH", "The record this plan was built from no longer exists.");
        unwrap(await call(`/zones/${zoneId}/dns_records/${existing.id}`, { method: "PUT", body, signal }));
      }
      // Read back rather than trusting the write's own response.
      const after = (await this.listDnsRecords({ zoneId, name: body.name, signal })).find((record) => record.type === body.type);
      const verified = Boolean(after) && after.content === body.content;
      return { verified, observed: after ?? null };
    },

    async deleteDnsRecord({ zoneId, recordId, signal }) {
      unwrap(await call(`/zones/${zoneId}/dns_records/${recordId}`, { method: "DELETE", signal }));
      const remaining = await this.listDnsRecords({ zoneId, signal });
      return { verified: !remaining.some((record) => record.id === recordId) };
    },

    async workerStatus({ accountId, scriptName, signal }) {
      const scripts = unwrap(await call(`/accounts/${accountId}/workers/scripts`, { signal })) ?? [];
      const script = scripts.find((entry) => entry.id === scriptName);
      return script
        ? { present: true, name: script.id, modifiedOn: script.modified_on ?? null }
        : { present: false, name: scriptName, modifiedOn: null };
    },

    async d1Status({ accountId, signal }) {
      const databases = unwrap(await call(`/accounts/${accountId}/d1/database`, { signal })) ?? [];
      return databases.map((database) => ({ uuid: database.uuid, name: database.name, version: database.version ?? null }));
    },

    async kvNamespaces({ accountId, signal }) {
      const namespaces = unwrap(await call(`/accounts/${accountId}/storage/kv/namespaces`, { signal })) ?? [];
      return namespaces.map((namespace) => ({ id: namespace.id, title: namespace.title }));
    },

    async r2Buckets({ accountId, signal }) {
      const payload = unwrap(await call(`/accounts/${accountId}/r2/buckets`, { signal }));
      const buckets = payload?.buckets ?? payload ?? [];
      return buckets.map((bucket) => ({ name: bucket.name, createdAt: bucket.creation_date ?? null }));
    },

    async browserRenderingStatus({ accountId, signal }) {
      try {
        const limits = unwrap(await call(`/accounts/${accountId}/browser-rendering/limits`, { signal }));
        return { available: true, limits: limits ?? null };
      } catch (error) {
        // Not entitled is a legitimate answer here, not a failure to report.
        if (error.code === "NOT_AUTHORIZED") return { available: false, reason: "This token or account is not entitled to Browser Rendering." };
        throw error;
      }
    },

    /** Token metadata only — the token itself is never echoed. */
    async verifyToken({ signal }) {
      const result = unwrap(await call("/user/tokens/verify", { signal }));
      return { status: result?.status ?? "unknown", value: redactValue(token) };
    },
  };
}

function summarizeRecord(record) {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl,
    proxied: Boolean(record.proxied),
  };
}
