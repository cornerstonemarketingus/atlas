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
    async planDnsRecord({ zoneId, type, name, content, ttl = 1, proxied = undefined, signal }) {
      const existing = (await this.listDnsRecords({ zoneId, name, signal })).find((record) => record.type === type);
      // Carried forward from the existing record when the caller did not say.
      // Defaulting to false silently un-proxied a proxied record, exposing the
      // origin IP and dropping the WAF on what looked like a content change.
      const nextProxied = proxied === undefined ? (existing?.proxied ?? false) : proxied;
      assertDnsName(name);
      return buildPlan({
        provider: "cloudflare",
        operation: existing ? "update" : "create",
        resource: "dns_record",
        // `fields` is what apply acts on. The human-readable `target` used to
        // be parsed back apart with split(" "), so a name containing a space
        // applied a different record than the one approved.
        fields: { zoneId, type, name, existingId: existing?.id ?? null },
        target: `${name} ${type} (zone ${zoneId})`,
        before: existing ? { type: existing.type, content: existing.content, ttl: existing.ttl, proxied: existing.proxied } : null,
        after: { type, content, ttl, proxied: nextProxied },
        reversible: Boolean(existing),
        notes: existing
          ? [`Restoring this means setting ${name} ${type} back to ${existing.content}.`]
          : ["This record does not exist yet; undoing means deleting it."],
      });
    },

    async applyDnsRecord({ zoneId, plan, signal }) {
      const fields = plan.fields;
      if (!fields?.name) throw new InfrastructureError("BAD_PLAN", "This plan predates structured DNS fields and cannot be applied. Re-plan the change.");
      if (fields.zoneId !== zoneId) throw new InfrastructureError("BAD_PLAN", "This plan was built for a different zone.");
      const body = { type: fields.type, name: fields.name, content: plan.after.content, ttl: plan.after.ttl, proxied: plan.after.proxied };

      // The zone can change between plan and apply. Both paths re-read and
      // refuse rather than writing over whatever is there now: a create that
      // finds a record would add a second one (splitting live traffic), and
      // an update that finds a different value would overwrite somebody's
      // emergency fix while reporting success.
      const current = (await this.listDnsRecords({ zoneId, name: fields.name, signal })).filter((record) => record.type === fields.type);
      if (plan.operation === "create") {
        if (current.length > 0) {
          throw new InfrastructureError("CHANGED_UNDERNEATH", `${fields.name} ${fields.type} now exists with content ${current[0].content}; it did not when this change was planned. Re-plan it.`);
        }
        unwrap(await call(`/zones/${zoneId}/dns_records`, { method: "POST", body, signal }));
      } else {
        const existing = current.find((record) => record.id === fields.existingId) ?? null;
        if (!existing) throw new InfrastructureError("CHANGED_UNDERNEATH", "The record this plan was built from no longer exists. Re-plan the change.");
        if (existing.content !== plan.before?.content) {
          throw new InfrastructureError("CHANGED_UNDERNEATH", `${fields.name} ${fields.type} is now ${existing.content}, not the ${plan.before?.content} this change was planned against. Re-plan it.`);
        }
        unwrap(await call(`/zones/${zoneId}/dns_records/${existing.id}`, { method: "PUT", body, signal }));
      }
      // Read back rather than trusting the write's own response.
      const after = (await this.listDnsRecords({ zoneId, name: fields.name, signal })).find((record) => record.type === fields.type);
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

/** A DNS name is rendered into a plan a human reads; it cannot carry prose. */
function assertDnsName(name) {
  if (!/^[A-Za-z0-9_*.@-]+$/u.test(name ?? "")) {
    throw new InfrastructureError("BAD_NAME", `'${String(name).slice(0, 80)}' is not a valid DNS record name.`);
  }
  return name;
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
