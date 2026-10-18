import { createApiClient, InfrastructureError } from "../infrastructure/adapter.mjs";
export const HUBSPOT_CREDENTIAL = "HUBSPOT_PRIVATE_APP_TOKEN";
const fields = ["email", "firstname", "lastname", "phone", "company"];
export function hubspotContacts({ token, fetchImpl = fetch }) {
  const call = createApiClient({ root: "https://api.hubapi.com", headers: { authorization: `Bearer ${token}` }, fetchImpl: async (url, input) => {
    let response;
    try { response = await fetchImpl(url, { ...input, redirect: "error" }); }
    catch { throw new InfrastructureError("CRM_UNAVAILABLE", "HubSpot could not be reached. A submitted change may still finish; check the contact before retrying."); }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* never surface provider error bodies */ }
      throw new InfrastructureError(response.status === 404 ? "CONTACT_NOT_FOUND" : [401, 403].includes(response.status) ? "NOT_AUTHORIZED" : "CRM_REQUEST_FAILED", `HubSpot returned HTTP ${response.status}. No automatic retry was sent.`);
    }
    return response;
  } });
  async function read(email, signal) {
    try {
      const contact = await call(`/crm/v3/objects/contacts/${encodeURIComponent(email)}`, { signal, query: { idProperty: "email", properties: fields.join(",") } });
      if (!/^\d+$/u.test(contact?.id ?? "") || contact?.archived || contact.properties?.email?.toLowerCase() !== email.toLowerCase()) throw new InfrastructureError("NOT_VERIFIED", "HubSpot returned an unexpected contact; no result is verified.");
      return contact;
    } catch (error) { if (error.code === "CONTACT_NOT_FOUND") return null; throw error; }
  }
  return {
    async find(email, signal) { const contact = await read(email, signal); return { found: Boolean(contact), contactId: contact?.id ?? null }; },
    async create(input, signal) {
      const properties = Object.fromEntries(fields.filter(field => input[field] !== undefined && input[field] !== "").map(field => [field, input[field]]));
      const existing = await read(input.email, signal);
      if (existing) return { created: false, contactId: existing.id, message: "Existing contact found. No fields were changed." };
      const result = await call("/crm/v3/objects/contacts", { method: "POST", body: { properties }, signal });
      if (!/^\d+$/u.test(result?.id ?? "")) throw new InfrastructureError("NOT_VERIFIED", "Contact submission returned no valid identifier. Inspect HubSpot before retrying.");
      const observed = await read(input.email, signal);
      if (!observed || observed.id !== result.id || Object.entries(properties).some(([key, value]) => key === "email" ? observed.properties[key]?.toLowerCase() !== value.toLowerCase() : observed.properties[key] !== value)) throw new InfrastructureError("NOT_VERIFIED", "Contact submission could not be confirmed by reading it back. Inspect HubSpot before retrying.");
      return { created: true, verified: true, contactId: result.id };
    },
  };
}
export function registerCrmTools(registry, { fetchImpl = fetch } = {}) {
  const email = { type: "string", minLength: 3, maxLength: 254, pattern: "^[^\\s@/]+@[^\\s@/]+\\.[^\\s@/]+$" };
  const common = { credentials: [HUBSPOT_CREDENTIAL], retries: 0, timeoutMs: 90000, maxOutputCharacters: 2000 };
  registry.register({ ...common, name: "crm.find_contact", description: "Find a HubSpot contact by email. Requires configured HubSpot credential and crm.read policy.", capability: "crm.read", risk: "moderate", requiresApproval: false,
    inputSchema: { type: "object", required: ["email"], properties: { email } },
    execute: ({ input, credentials, signal }) => hubspotContacts({ token: credentials[HUBSPOT_CREDENTIAL], fetchImpl }).find(input.email, signal),
  });
  registry.register({ ...common, name: "crm.create_contact", description: "Create a HubSpot contact after approval and verify by reading it back. Reuses an existing contact without changing its fields. Does not send messages or save an inquiry note.", capability: "crm.write", risk: "high", requiresApproval: true,
    inputSchema: { type: "object", required: ["email"], properties: { email, ...Object.fromEntries(fields.filter(field => field !== "email").map(field => [field, { type: "string", minLength: 1, maxLength: field === "phone" ? 80 : 200 }])) } },
    execute: ({ input, credentials, signal }) => hubspotContacts({ token: credentials[HUBSPOT_CREDENTIAL], fetchImpl }).create(input, signal),
  });
  return registry;
}
