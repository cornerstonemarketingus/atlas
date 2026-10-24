/** Hosted inspect currently emits inventory only; it cannot answer arbitrary questions. */
export function isInventoryObjective(objective) {
  const text = String(objective ?? "").trim();
  return /^(inspect|overview|inventory|summari[sz]e)( the)?( repository| codebase| project)?[.!]?$/i.test(text);
}
