import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GENESIS_STATES, GenesisService, GenesisStore, canTransition, createGenesisRoutes, executionOrder, inferSpecification, planProject,
} from "../src/platform/genesis/index.mjs";

const withDirectory = async (run) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-genesis-"));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};

test("the lifecycle allows the build path and refuses shortcuts", () => {
  const path = ["idea", "requirements", "planned", "approved", "scaffolding", "building", "verifying", "previewing", "reviewing", "ready", "publishing", "published"];
  for (let i = 0; i < path.length - 1; i += 1) assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]}`);
  // Verification cannot be skipped, and nothing jumps to ready or published.
  for (const [from, to] of [["building", "ready"], ["building", "previewing"], ["verifying", "ready"], ["idea", "building"], ["planned", "scaffolding"], ["ready", "published"]]) {
    assert.equal(canTransition(from, to), false, `${from} → ${to} must be refused`);
  }
  // Repairs loop back into verification; failed checks never lead straight on.
  assert.ok(canTransition("verifying", "repairing") && canTransition("repairing", "verifying") && canTransition("previewing", "repairing") && canTransition("reviewing", "repairing"));
  // Holds resume only to where they were; cancelled is final.
  assert.ok(canTransition("paused", "building", { resumeTo: "building" }));
  assert.equal(canTransition("paused", "ready", { resumeTo: "building" }), false);
  for (const state of GENESIS_STATES.filter((s) => s !== "cancelled")) assert.ok(canTransition(state, "cancelled"));
  assert.equal(canTransition("cancelled", "requirements"), false);
  // A finished project stays editable.
  assert.ok(canTransition("ready", "requirements") && canTransition("published", "requirements"));
});

test("specifications infer sensible defaults and ask only material questions", () => {
  const roofing = inferSpecification("Build a website for my roofing company");
  assert.equal(roofing.archetype, "website");
  assert.deepEqual(roofing.pages.map((p) => p.id), ["home", "services", "about", "gallery", "contact"]);
  assert.deepEqual(roofing.questions, [], "a roofing website needs no questions");
  assert.ok(roofing.workflows.some((w) => w.id === "lead"));
  assert.ok(roofing.assumptions.some((a) => /SEO/u.test(a)));
  assert.equal(roofing.auth.required, false);

  const leads = inferSpecification("Build a simple customer lead tracker with: add customer, name/email/phone, status, notes, dashboard, search");
  assert.equal(leads.archetype, "webapp");
  assert.deepEqual(leads.entities.map((e) => [e.name, e.fields.map((f) => f.key)]), [["Customer", ["name", "email", "phone", "status", "notes"]]]);
  assert.ok(leads.entities[0].fields.find((f) => f.key === "status").options.includes("Won"));
  assert.ok(leads.workflows.some((w) => w.id === "find-customer"));
  assert.ok(leads.acceptanceCriteria.some((c) => /Find customers/u.test(c)));

  const crm = inferSpecification("Atlas, build me a simple CRM for my construction company.");
  assert.equal(crm.name, "Construction CRM");
  assert.deepEqual(crm.entities.map((e) => e.name), ["Contact", "Deal"]);
  assert.ok(!crm.entities[0].fields.some((f) => f.key === "company" && crm.entities[0].fields.filter((x) => x.key === "company").length > 1));

  const booking = inferSpecification("Build me a booking website for my landscaping company.");
  assert.equal(booking.archetype, "webapp");
  assert.ok(booking.pages.some((p) => p.id === "book"));
  assert.ok(booking.entities[0].fields.some((f) => f.key === "date"));

  const api = inferSpecification("Build a REST API for managing inventory items");
  assert.equal(api.archetype, "api");
  assert.equal(api.pages.length, 0);

  const team = inferSpecification("Build a small app where my team can log in and track tasks");
  assert.deepEqual({ required: team.auth.required, method: team.auth.method }, { required: true, method: "password" });

  const store = inferSpecification("Build an online store that takes payments for my bakery");
  assert.deepEqual(store.questions.map((q) => q.id), ["payments"], "payments change cost and credentials, so Atlas asks");
  assert.equal(inferSpecification("Build an online store that takes payments", { answers: { payments: "no" } }).questions.length, 0);

  assert.deepEqual(inferSpecification("Build a website for my roofing company"), roofing, "the same prompt gives the same specification");
});

test("plans are bounded tasks with dependencies, verification and a named executor", () => {
  for (const prompt of ["Build a website for my roofing company", "Build a simple customer lead tracker with name/email/phone, status, notes", "Build a REST API for managing inventory items", "Build a small app where my team can log in and track tasks, and email me reminders"]) {
    const plan = planProject(inferSpecification(prompt));
    assert.ok(plan.tasks.length >= 4 && plan.tasks.length <= 16, prompt);
    for (const task of plan.tasks) {
      assert.ok(task.objective && task.verification.length && task.outputs.length, `${task.id} is fully specified`);
      assert.ok(["template", "coder", "checks", "browser"].includes(task.executor));
      assert.doesNotMatch(task.objective, /build (the|an?) (entire|whole) app/iu);
    }
    const order = executionOrder(plan.tasks);
    assert.equal(order[0], "t1", "scaffolding comes first");
    assert.ok(order.indexOf(plan.tasks.find((t) => t.executor === "checks").id) > order.indexOf("t1"));
    assert.ok(plan.tasks.some((t) => t.executor === "browser"), "every plan opens the running app");
  }
  const withAuth = planProject(inferSpecification("Build a small app where my team can log in and track tasks, and email me reminders"));
  assert.ok(withAuth.tasks.some((t) => /sign-in/u.test(t.title) && t.executor === "coder"));
  assert.ok(withAuth.tasks.some((t) => /email/u.test(t.title) && /off by default/u.test(t.objective)));
  assert.equal(planProject(inferSpecification("Build a website for my roofing company")).template, "static-site");
  assert.equal(planProject(inferSpecification("Build a REST API for managing inventory items")).template, "api-service");
  assert.throws(() => executionOrder([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }]), /cycle/u);
});

test("a project is planned and approved with evidence, and survives a restart", () => withDirectory(async (directory) => {
  const file = join(directory, "genesis.sqlite");
  let store = new GenesisStore(file);
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const project = await genesis.create("Build a simple customer lead tracker with: add customer, name/email/phone, status, notes, dashboard, search");
  assert.equal(project.state, "approved");
  assert.deepEqual(project.transitions.map((t) => t.to), ["idea", "requirements", "planned", "approved"]);
  assert.ok(project.transitions.every((t) => t.reason && t.evidence), "every transition has a reason and evidence");
  assert.equal(project.transitions.find((t) => t.to === "planned").evidence.template, "web-app");
  assert.ok(project.tasks.length >= 5 && project.tasks.every((t) => t.status === "pending" && t.attempts === 0));
  assert.ok(project.progress.steps.some((s) => s.label.startsWith("Plan:") && s.done));

  // The executor moves it on through the same rules, then Atlas "crashes".
  genesis.advance(project.id, "scaffolding", { reason: "Creating the workspace.", evidence: { kind: "workspace" }, patch: { workspace: "/tmp/x" } });
  store.updateTask("local", project.id, "t1", { status: "running", attempt: true, evidence: { kind: "start" } });
  assert.throws(() => genesis.advance(project.id, "ready", { reason: "skip" }), /cannot move from scaffolding to ready/u);
  store.close();

  store = new GenesisStore(file);
  const restarted = new GenesisService({ store });
  const recovered = restarted.recover();
  assert.equal(recovered.length, 1);
  const view = restarted.view(project.id);
  assert.equal(view.state, "paused");
  assert.equal(view.resumeTo, "scaffolding");
  assert.equal(view.workspace, "/tmp/x");
  assert.equal(view.tasks.find((t) => t.id === "t1").attempts, 1);
  assert.match(view.transitions.at(-1).reason, /restarted while creating the project/u);
  assert.equal(restarted.resume(project.id).state, "scaffolding");
  store.close();
}));

test("questions block until answered; plans wait for approval when the policy asks", () => withDirectory(async (directory) => {
  const store = new GenesisStore(join(directory, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "ask" }) });
  const shop = await genesis.create("Build an online store that takes payments for my bakery");
  assert.equal(shop.state, "blocked");
  assert.equal(shop.resumeTo, "requirements");
  assert.equal(shop.tasks.length, 0, "nothing is planned while an answer is missing");
  await assert.rejects(genesis.answer(shop.id, {}), /Still needed: payments/u);
  const answered = await genesis.answer(shop.id, { payments: "no, I take payment in person" });
  assert.equal(answered.state, "planned", "the owner's policy says ask, so it waits");
  assert.ok(answered.spec.assumptions.some((a) => /in person/u.test(a)));
  assert.equal(genesis.approve(shop.id).state, "approved");
  store.close();
}));

test("a finished project takes changes conversationally instead of starting over", () => withDirectory(async (directory) => {
  const store = new GenesisStore(join(directory, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const project = await genesis.create("Build a simple customer lead tracker with name/email/phone, status, notes");
  for (const [to, reason] of [["scaffolding", "s"], ["building", "b"], ["verifying", "v"], ["previewing", "p"], ["reviewing", "r"], ["ready", "done"]]) genesis.advance(project.id, to, { reason });
  const changed = await genesis.change(project.id, "Add Google login");
  assert.equal(changed.id, project.id, "same project");
  assert.equal(changed.state, "approved");
  assert.deepEqual({ required: changed.spec.auth.required, method: changed.spec.auth.method }, { required: true, method: "google" });
  assert.equal(changed.spec.version, 2);
  assert.ok(changed.tasks.some((t) => /google sign-in/iu.test(t.title)));
  assert.match(changed.transitions.find((t) => t.to === "requirements" && t.evidence.kind === "change").reason, /Add google sign-in/u);
  await assert.rejects(async () => { genesis.advance(project.id, "scaffolding", { reason: "s" }); await genesis.change(project.id, "add phone"); }, /pause it or wait/u);
  store.close();
}));

test("a refinement from the Intelligence Layer is used only when it keeps the contract", () => withDirectory(async (directory) => {
  const store = new GenesisStore(join(directory, "genesis.sqlite"));
  const good = new GenesisService({ store, intelligence: { name: "test-model", refineSpecification: async ({ draft }) => ({ ...draft, name: "Refined Name" }) } });
  assert.equal((await good.create("Build a website for my roofing company")).name, "Refined Name");
  const broken = new GenesisService({ store, intelligence: { refineSpecification: async () => ({ nonsense: true }), refinePlan: async () => { throw new Error("model down"); } } });
  const kept = await broken.create("Build a website for my roofing company");
  assert.equal(kept.name, "Roofing Website");
  assert.ok(kept.tasks.length > 0, "a failing planner falls back to the deterministic plan");
  store.close();
}));

test("routes: read for any signed-in caller, act for the owner", () => withDirectory(async (directory) => {
  const store = new GenesisStore(join(directory, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const handle = createGenesisRoutes({ genesis, parseBody: async (request) => request.body ?? {}, send: (response, status, value) => { response.status = status; response.body = value; return true; } });
  const call = async (method, url, role, body) => { const response = {}; await handle({ method, url, body }, response, { role }); return response; };
  assert.equal((await call("POST", "/v1/genesis", "device", { prompt: "Build a site" })).status, 403);
  assert.equal((await call("POST", "/v1/genesis", "admin", { prompt: "" })).status, 400);
  const created = await call("POST", "/v1/genesis", "admin", { prompt: "Build a website for my roofing company" });
  assert.equal(created.status, 201);
  const id = created.body.project.id;
  assert.equal((await call("GET", "/v1/genesis", "device")).body.projects[0].id, id);
  assert.deepEqual((await call("GET", "/v1/genesis/templates", "device")).body.templates.map((t) => t.id), ["web-app", "static-site", "api-service"]);
  assert.equal((await call("GET", `/v1/genesis/${id}`, "device")).body.project.state, "approved");
  const paused = await call("POST", `/v1/genesis/${id}/pause`, "admin", {});
  assert.deepEqual([paused.status, paused.body.project.state], [200, "paused"]);
  assert.equal((await call("POST", `/v1/genesis/${id}/approve`, "admin", {})).status, 409, "a paused project is not planned");
  assert.equal((await call("POST", `/v1/genesis/${id}/resume`, "admin", {})).body.project.state, "approved");
  assert.equal((await call("POST", `/v1/genesis/${id}/cancel`, "admin", {})).body.project.state, "cancelled");
  assert.equal((await call("POST", `/v1/genesis/${id}/resume`, "admin", {})).status, 409);
  assert.equal((await call("GET", "/v1/genesis/gen_00000000-0000-0000-0000-000000000000", "admin")).status, 404);
  store.close();
}));
