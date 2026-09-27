/**
 * Turns a Genesis specification into bounded implementation tasks.
 *
 * No task is "build the whole application": each has one objective, the
 * inputs it relies on, the outputs it must produce, the tasks it depends on,
 * and verification criteria a check or the browser can confirm. Each task
 * also names who carries it out:
 *
 * - template: deterministic scaffold/generation from a curated template
 *   (no model, same result every time);
 * - coder:    Atlas's existing coder (packages/atlas-cli `code`) in the
 *   project workspace, verifying and repairing its own edit;
 * - checks:   install/typecheck/lint/test/build commands the template declares;
 * - browser:  the running preview opened and exercised in a real browser.
 */

export const MAX_TASKS = 16;

/** Which curated template fits an archetype (templates themselves live in templates/). */
export function templateFor(spec) {
  if (spec.archetype === "website") return "static-site";
  if (spec.archetype === "api") return "api-service";
  return "web-app";
}

export function planProject(spec) {
  const template = templateFor(spec);
  const tasks = [];
  const add = (fields) => {
    const id = `t${tasks.length + 1}`;
    tasks.push({ status: "pending", inputs: [], outputs: [], verification: [], ...fields, dependsOn: (fields.dependsOn ?? []).filter(Boolean), id });
    return id;
  };

  const scaffold = add({
    title: "Create the project",
    kind: "scaffold",
    executor: "template",
    objective: `Create a local project from the ${template} template, named "${spec.name}", with its own git repository.`,
    inputs: ["specification"],
    outputs: ["project workspace", "git repository with an initial commit"],
    verification: ["workspace contains the template's files", "git repository has an initial commit"],
  });

  let data = null;
  if (spec.entities.length) {
    data = add({
      title: "Create the data model",
      kind: "generate",
      executor: "template",
      objective: `Generate storage and validation for ${spec.entities.map((e) => `${e.name} (${e.fields.map((f) => f.key).join(", ")})`).join("; ")}.`,
      inputs: ["specification.entities"],
      outputs: ["data model", "validation rules", "unit tests for each record type"],
      dependsOn: [scaffold],
      verification: spec.entities.map((e) => `${e.name} records can be created, listed, updated and deleted in tests`),
    });
  }

  const featureTasks = [];
  if (spec.archetype === "website") {
    featureTasks.push(add({
      title: "Build the pages",
      kind: "generate",
      executor: "template",
      objective: `Generate ${spec.pages.map((p) => p.title).join(", ")} with real copy for ${spec.targetUsers.toLowerCase()}, shared navigation and SEO basics.`,
      inputs: ["specification.pages", "specification.design"],
      outputs: spec.pages.map((p) => `${p.title} page`),
      dependsOn: [scaffold],
      verification: spec.pages.map((p) => `${p.title} page shows its heading and content`),
    }));
    featureTasks.push(add({
      title: "Build the enquiry form",
      kind: "generate",
      executor: "template",
      objective: "Contact form with name, email, phone and message; validates input and shows a confirmation.",
      inputs: ["specification.workflows.lead"],
      outputs: ["contact form", "form validation"],
      dependsOn: [featureTasks[0]],
      verification: ["an empty form shows errors", "a valid submission shows a confirmation"],
    }));
  } else if (spec.archetype === "api") {
    for (const entity of spec.entities) {
      featureTasks.push(add({
        title: `Build the ${entity.name.toLowerCase()} endpoints`,
        kind: "generate",
        executor: "template",
        objective: `JSON endpoints to create, list (with search), read, update and delete ${entity.name.toLowerCase()} records, with input validation.`,
        inputs: [`specification.entities.${entity.name}`],
        outputs: [`/api/${entity.name.toLowerCase()}s endpoints`, "endpoint tests"],
        dependsOn: [data],
        verification: [`${entity.name} endpoints return correct status codes`, "invalid input returns 400 with a message"],
      }));
    }
  } else {
    for (const entity of spec.entities) {
      featureTasks.push(add({
        title: `Build the ${entity.name.toLowerCase()} screens`,
        kind: "generate",
        executor: "template",
        objective: `${entity.name}s page: list with search, add and edit forms, delete with confirmation${entity.fields.some((f) => f.type === "select") ? ", status changes" : ""}.`,
        inputs: [`specification.entities.${entity.name}`, "specification.design"],
        outputs: [`${entity.name}s page`, `${entity.name} form`],
        dependsOn: [data],
        verification: [`adding a ${entity.name.toLowerCase()} shows it in the list`, "search shows only matching rows", "required fields are enforced"],
      }));
    }
    if (spec.pages.some((p) => p.id === "book")) {
      featureTasks.push(add({
        title: "Build the booking form",
        kind: "generate",
        executor: "template",
        objective: "Public booking page: service, date, time and contact details; creates a Requested booking and shows a confirmation.",
        inputs: ["specification.workflows.book"],
        outputs: ["Book page"],
        dependsOn: [data],
        verification: ["a valid booking appears in Bookings as Requested", "a booking without a date is rejected"],
      }));
    }
    featureTasks.push(add({
      title: "Build the dashboard",
      kind: "generate",
      executor: "template",
      objective: `Dashboard with counts${spec.entities.some((e) => e.fields.some((f) => f.type === "select")) ? " by status" : ""} and recent records.`,
      inputs: ["specification.entities"],
      outputs: ["Dashboard page"],
      dependsOn: [data],
      verification: ["dashboard counts match the stored records"],
    }));
  }

  if (spec.auth.required) {
    featureTasks.push(add({
      title: `Add ${spec.auth.method === "password" ? "email and password" : spec.auth.method} sign-in`,
      kind: "code",
      executor: "coder",
      objective: spec.auth.method === "password"
        ? "Add sign-in with email and a hashed password (scrypt), a session cookie (HttpOnly, SameSite=Lax), sign-out, and require sign-in for every private page and API route. Add tests."
        : `Add ${spec.auth.method} sign-in behind configuration (switched off until a client id is set), keep the app usable locally, require sign-in for private routes when enabled, and add tests.`,
      inputs: ["specification.auth"],
      outputs: ["sign-in page", "session handling", "auth tests"],
      dependsOn: featureTasks.length ? [...featureTasks] : [scaffold],
      verification: ["private pages redirect to sign-in when signed out", "signing in reaches the dashboard", "auth tests pass"],
    }));
  }

  for (const integration of spec.integrations.filter((i) => !["maps", "google-oauth"].includes(i.id))) {
    featureTasks.push(add({
      title: `Prepare ${integration.label.toLowerCase()}`,
      kind: "code",
      executor: "coder",
      objective: `Add ${integration.label.toLowerCase()} behind a configuration switch that is off by default (it needs ${integration.needs}); the app must work fully with it off. No real credentials in the code.`,
      inputs: [`specification.integrations.${integration.id}`],
      outputs: [`${integration.label} module, disabled by default`],
      dependsOn: [scaffold],
      verification: ["the app builds and its tests pass with the integration switched off", "no secrets are committed"],
    }));
  }

  for (const change of spec.changeLog?.at(-1)?.changes?.filter((c) => c.kind === "feature") ?? []) {
    featureTasks.push(add({
      title: change.summary.slice(0, 80),
      kind: "code",
      executor: "coder",
      objective: `${change.summary} Keep existing behaviour working and add tests for the change.`,
      inputs: ["specification", "existing project"],
      outputs: ["the requested change", "tests for it"],
      dependsOn: [scaffold],
      verification: ["the change is visible in the running app", "all tests still pass"],
    }));
  }

  const verify = add({
    title: "Test the application",
    kind: "verify",
    executor: "checks",
    objective: "Install dependencies, then run the template's typecheck, lint, tests and build.",
    inputs: ["project workspace"],
    outputs: ["check results"],
    dependsOn: featureTasks.length ? featureTasks : [scaffold],
    verification: ["every declared check exits 0"],
  });
  const preview = add({
    title: "Open and check the application",
    kind: "verify",
    executor: "browser",
    objective: "Start the preview, open every page in a browser at phone and desktop widths, and run the critical workflows.",
    inputs: ["running preview", "specification.workflows", "specification.acceptanceCriteria"],
    outputs: ["browser evidence per page and workflow"],
    dependsOn: [verify],
    verification: spec.archetype === "api"
      ? ["every endpoint answers with the expected status and JSON"]
      : ["pages load with no runtime or console errors", "expected headings are present", "critical workflows complete", "no horizontal overflow at 375px"],
  });
  if (spec.archetype !== "api") {
    add({
      title: "Polish the interface",
      kind: "polish",
      executor: "coder",
      objective: "One bounded pass on spacing, hierarchy, empty/loading/error states, form labels and focus styles, using the browser findings. No redesign.",
      inputs: ["browser evidence"],
      outputs: ["interface fixes"],
      dependsOn: [preview],
      verification: ["browser checks still pass", "no placeholder text remains"],
    });
  }

  if (tasks.length > MAX_TASKS) throw new Error(`A Genesis plan may have at most ${MAX_TASKS} tasks; this one has ${tasks.length}. Split the request.`);
  return { template, tasks, summary: `${tasks.length} tasks using the ${template} template` };
}

/** Kahn order over dependsOn; throws on a cycle or an unknown dependency. */
export function executionOrder(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) for (const dep of t.dependsOn) if (!ids.has(dep)) throw new Error(`Task ${t.id} depends on unknown task ${dep}.`);
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn)]));
  const order = [];
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (!ready.length) throw new Error("The plan has a dependency cycle.");
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const deps of remaining.values()) deps.delete(id);
    }
  }
  return order;
}
