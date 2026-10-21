import { BUDGET_DIMENSIONS } from "./budget.mjs";

/** Explicit owner-configured preparation bounds, shared by intake and dispatch. */
export function normalizeBusinessReview(input) {
  const fail = () => { throw Object.assign(new Error("Business review requires exact business/responsibility IDs, repository, model and all five non-negative integer budget limits; unknown fields are refused."), { code: "INVALID_AUTOMATION" }); };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  const keys = ["kind", "businessId", "responsibilityId", "repository", "model", "budget"];
  if (Object.keys(input).some(key => !keys.includes(key)) || input.kind !== "business-review") fail();
  for (const key of ["businessId", "responsibilityId"]) if (typeof input[key] !== "string" || !/^[a-z0-9-]{1,64}$/u.test(input[key])) fail();
  for (const [key, max] of [["repository", 4096], ["model", 200]]) if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > max) fail();
  const budget = input.budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget) || Object.keys(budget).length !== BUDGET_DIMENSIONS.length || Object.keys(budget).some(key => !BUDGET_DIMENSIONS.includes(key)) || !BUDGET_DIMENSIONS.every(key => Number.isSafeInteger(budget[key]) && budget[key] >= 0)) fail();
  return { kind: input.kind, businessId: input.businessId, responsibilityId: input.responsibilityId, repository: input.repository.trim(), model: input.model.trim(), budget: { ...budget } };
}
