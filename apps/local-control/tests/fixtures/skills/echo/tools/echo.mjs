// Fixture skill tool: self-contained (loaded from verified bytes as a data: URL).
export async function execute(input, context = {}) {
  return { output: { echoed: String(input.text).toUpperCase(), skill: context.skill?.version ?? null } };
}
