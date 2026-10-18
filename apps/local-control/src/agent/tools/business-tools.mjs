import { ToolError } from "../tool-registry.mjs";

const id = { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" };
const template = { type: "string", enum: ["construction-launch", "self-improvement"], default: "construction-launch" };

/** Read-only business intake. Mutations remain on the owner-authenticated HTTP surface. */
export function registerBusinessTools(registry, getBusinessService) {
  const register = (name, description, properties, required, read) => registry.register({
    name: `business.${name}`, description,
    capability: "business.read", risk: "low", requiresApproval: false,
    effects: { writes: false }, timeoutMs: 10_000, maxOutputCharacters: 32_000,
    inputSchema: { type: "object", additionalProperties: false, properties, required },
    execute({ input }) {
      const service = getBusinessService();
      if (!service) throw new ToolError("BUSINESS_UNAVAILABLE", "The local business service is unavailable.");
      return { operation: `business.${name}`, mode: "read-only", ...read(service, input) };
    },
  });
  register("list", "List local businesses and their recorded objectives. Use to identify the business before inspecting or previewing a preparation plan. Does not create or launch work.", {}, [],
    service => ({ businesses: service.list() }));
  register("inspect", "Inspect a local business objective, execution budget and persistent responsibilities by its exact ID. Recorded objectives are not verified outcomes.", { businessId: id }, ["businessId"],
    (service, input) => {
      const business = service.get(input.businessId);
      if (!business) throw new ToolError("BUSINESS_NOT_FOUND", "Business not found.");
      return { business };
    });
  register("due", "List persistent business responsibilities currently due for review. This only reads the due list; it does not dispatch work or record reviews.", {}, [],
    service => ({ responsibilities: service.due() }));
  register("plan", "Preview a preparation plan for an existing local business. Construction-launch prepares website, hosting, CRM and leads artifacts; self-improvement prepares proposals. This does not create a mission, deploy, purchase, send outreach or prove any live business outcome. Use the owner's Businesses page for creating businesses or starting missions.", { businessId: id, template }, ["businessId"],
    (service, input) => ({ plan: service.plan(input.businessId, input.template), executed: false,
      limitations: ["Preparation preview only; no mission started.", "No hosting, CRM delivery, outreach or business outcome verified."] }));
}
