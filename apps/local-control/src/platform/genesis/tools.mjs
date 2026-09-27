import { STATE_LABELS } from "./lifecycle.mjs";

/**
 * Chat tools for Project Genesis, so "Atlas, build me a simple CRM for my
 * construction company" works from a conversation, and "Add Google login"
 * continues that project instead of starting over.
 *
 * Building locally only writes inside the project folder, so these tools run
 * under the `genesis.build` capability (allowed by default, changeable in
 * Settings → Policies). Publishing is not here: it goes through the existing
 * approval system.
 */

function describe(view) {
  const lines = [`${view.name} — ${STATE_LABELS[view.state]} (project ${view.id}).`];
  if (view.spec?.questions?.length && view.state === "blocked") {
    lines.push("Atlas needs answers before planning:", ...view.spec.questions.map((q) => `- [${q.id}] ${q.question}`));
  }
  if (view.state === "blocked" && !view.spec?.questions?.length) lines.push(`Waiting: ${view.transitions.at(-1)?.reason ?? ""}`);
  if (view.spec && ["approved", "planned", "requirements"].includes(view.state)) {
    lines.push("Assumptions:", ...view.spec.assumptions.slice(0, 6).map((a) => `- ${a}`));
    if (view.tasks.length) lines.push(`Plan: ${view.tasks.length} tasks (${view.tasks.map((t) => t.title).join("; ")}).`);
  }
  const steps = view.progress.steps.filter((step) => step.status || step.done);
  if (["scaffolding", "building", "verifying", "previewing", "repairing", "reviewing"].includes(view.state)) {
    lines.push(`Working: ${STATE_LABELS[view.state]}.`, ...steps.map((step) => `${step.done ? "✓" : step.status === "running" ? "●" : step.status === "failed" ? "✗" : "·"} ${step.label}`));
  }
  if (view.state === "ready" || view.state === "published") {
    const summary = view.transitions.findLast((t) => t.to === "ready")?.evidence?.summary;
    if (summary) {
      lines.push(`Open it: ${summary.preview}`, `Features: ${summary.features.join(", ")}.`);
      const tests = summary.verification.find((v) => v.step === "test")?.tests;
      lines.push(`Verified: ${summary.verification.map((v) => `${v.step} ${v.ok ? "passed" : "failed"}`).join(", ")}${tests ? ` (${tests.pass} tests)` : ""}; interface checked ${summary.inspection.limited ? "over HTTP only" : "in a browser"}.`);
      if (summary.limitations.length) lines.push("Limitations:", ...summary.limitations.map((l) => `- ${l}`));
      lines.push(`Files: ${summary.folder}`);
    }
  }
  if (view.state === "failed") lines.push(`Stopped: ${view.transitions.at(-1)?.reason ?? ""} Ask to retry, or describe a change.`);
  lines.push(`Follow along in the local app under Build (#/build/${view.id}).`);
  return lines.join("\n");
}

function latest(genesis, projectId) {
  if (projectId) return genesis.view(projectId);
  const [first] = genesis.list();
  if (!first) throw new Error("There is no Genesis project yet. Ask Atlas to build something first.");
  return genesis.view(first.id);
}

export function registerGenesisTools(registry, getGenesis, getPublisher = () => null) {
  const common = { capability: "genesis.build", risk: "low", requiresApproval: false, timeoutMs: 30_000, maxOutputCharacters: 4_000 };
  registry.register({
    ...common,
    name: "genesis.build",
    description: "Start building a new application from the person's description (a website, web app, dashboard, tracker, CRM, booking site or API). Atlas writes the requirements with sensible assumptions, plans it, builds it on this computer, tests it, runs it, checks it in a browser and repairs problems. Use for 'build me …', 'make an app/site that …'. Do NOT use to change an existing project; use genesis.change for that.",
    inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string", minLength: 3, maxLength: 4000, description: "What to build, in the person's words." } } },
    async execute({ input }) {
      const view = await getGenesis().create(input.prompt);
      return `Started.\n${describe(view)}`;
    },
  });
  registry.register({
    ...common,
    name: "genesis.status",
    description: "Report progress on a Genesis project: its stage, what passed, the preview link when ready, and limitations. Without projectId it reports the most recent project.",
    inputSchema: { type: "object", required: [], properties: { projectId: { type: "string", pattern: "^gen_[0-9a-f-]{36}$" } } },
    async execute({ input }) {
      return describe(latest(getGenesis(), input.projectId));
    },
  });
  registry.register({
    ...common,
    name: "genesis.change",
    description: "Change an application Atlas already built or is planning (for example 'Add Google login', 'add a phone field', 'track deal value'). Continues the same project: the requirements are updated, the change is planned, built and verified again. Without projectId it changes the most recent project.",
    inputSchema: { type: "object", required: ["request"], properties: { projectId: { type: "string", pattern: "^gen_[0-9a-f-]{36}$" }, request: { type: "string", minLength: 3, maxLength: 2000 } } },
    async execute({ input }) {
      const genesis = getGenesis();
      const target = latest(genesis, input.projectId);
      const view = await genesis.change(target.id, input.request);
      return `Change accepted.\n${describe(view)}`;
    },
  });
  registry.register({
    ...common,
    name: "genesis.publish",
    description: "Publish a ready Genesis project's code to a repository the person already created on their git host (GitHub, GitLab, Forgejo…), using their own git sign-in. This only files the request: Atlas's publish.remote policy decides, and by default the owner must approve it under Approvals before anything is pushed. Never call it unless the person asked to publish, push or put the code online, and never invent the repository address.",
    inputSchema: { type: "object", required: ["remote"], properties: { projectId: { type: "string", pattern: "^gen_[0-9a-f-]{36}$" }, remote: { type: "string", maxLength: 300, description: "The repository address the person gave, e.g. https://github.com/them/app.git" } } },
    async execute({ input }) {
      const publisher = getPublisher();
      if (!publisher) return "Publishing is not available in this Atlas.";
      const target = latest(getGenesis(), input.projectId);
      try {
        const result = await publisher.request(target.id, { remote: input.remote });
        if (result.status === "awaiting-approval") return `Waiting for the owner's approval under Approvals to publish ${target.name} (commit ${result.commit.slice(0, 8)}) to ${result.remote}. Nothing has been pushed yet.`;
        if (result.status === "published") return `Published ${target.name} to ${result.remote}.`;
        return `Publishing failed: ${result.message}`;
      } catch (error) {
        return `Not published: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    },
  });
  registry.register({
    ...common,
    name: "genesis.answer",
    description: "Give the answers a Genesis project is waiting for (the question ids come from genesis.status). Without projectId it answers the most recent project.",
    inputSchema: { type: "object", required: ["answers"], properties: { projectId: { type: "string", pattern: "^gen_[0-9a-f-]{36}$" }, answers: { type: "object", additionalProperties: { type: "string", maxLength: 500 } } } },
    async execute({ input }) {
      const genesis = getGenesis();
      const target = latest(genesis, input.projectId);
      return describe(await genesis.answer(target.id, input.answers));
    },
  });
}

export { describe as describeProject };
