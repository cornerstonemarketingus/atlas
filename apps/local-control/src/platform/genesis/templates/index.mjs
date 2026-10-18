import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Curated Genesis templates: a few that always work, not every framework.
 *
 * Each template is versioned and declares everything Atlas needs to run it
 * without guessing: its files, the commands that check, test and build it,
 * how to start its preview and what URL proves it is up, and its project
 * structure. All three use only Node's standard library (http, sqlite, test
 * runner), so a generated project installs nothing, works offline, and runs
 * wherever Atlas runs. Every server sends a strict CSP, nosniff and
 * no-referrer headers, caps request bodies, binds to 127.0.0.1 by default and
 * renders stored text with textContent/escaping.
 *
 * `configure(spec)` turns a Genesis specification into the template's
 * configuration files (app.config.json or site.json, package.json, README).
 * The template code reads that configuration, so the features a spec asks
 * for (record types, fields, search, status, dashboard, booking, pages, lead
 * form) are real, tested behaviour, not generated stubs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const COMMON_SHARED = ["src/http.mjs", "scripts/check.mjs"];
/**
 * Atlas backend primitives every generated app gets by default: sign-in,
 * file storage, per-app secrets and scheduled jobs. The cron parser is the
 * one Atlas automations use, copied in so the app stays dependency-free.
 */
const BACKEND = ["tests/backend.test.mjs", "src/backend.mjs", "src/auth.mjs", "src/files.mjs", "src/secrets.mjs", "scripts/secret.mjs", "src/jobs.mjs", "src/queue.mjs", { from: "../../automations/cron.mjs", target: "src/cron.mjs" }];

/** Secret names for the integrations a spec asks for; values are set by the owner, never generated. */
const INTEGRATION_SECRETS = { payments: ["PAYMENTS_SECRET_KEY"], email: ["EMAIL_API_KEY"], sms: ["SMS_API_KEY"], "google-oauth": ["GOOGLE_CLIENT_SECRET"], calendar: [] };

const ACCENTS = { blue: "#2563eb", green: "#15803d", red: "#b91c1c", orange: "#c2410c", purple: "#7c3aed", teal: "#0f766e", earthy: "#8a5a2b", warm: "#c2410c", dark: "#334155", black: "#1f2937" };

function accentFor(spec) {
  const colour = spec.design?.colours?.find((name) => ACCENTS[name]);
  if (colour) return ACCENTS[colour];
  // The trade, not the whole prompt: every prompt starts with "Build …".
  const trade = spec.business?.phrase ?? "";
  if (/landscap|garden|lawn|tree|farm/iu.test(trade)) return "#15803d";
  if (/roof|construct|renovat|remodel|carpent|builder/iu.test(trade)) return "#b45309";
  if (/clean|plumb|pool|water/iu.test(trade)) return "#0e7490";
  if (/bak|cafe|restaurant|food/iu.test(trade)) return "#c2410c";
  return "#2563eb";
}

const slugOf = (name) => {
  const lower = name.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "");
  return lower.endsWith("y") && !/[aeiou]y$/u.test(lower) ? `${lower.slice(0, -1)}ies` : lower.endsWith("s") ? `${lower}es` : `${lower}s`;
};
const pluralOf = (name) => (name.endsWith("y") && !/[aeiou]y$/iu.test(name) ? `${name.slice(0, -1)}ies` : name.endsWith("s") ? `${name}es` : `${name}s`);

function packageJson(spec, scripts) {
  const name = spec.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60) || "atlas-app";
  return `${JSON.stringify({ name, version: "0.1.0", private: true, type: "module", engines: { node: ">=22.13.0" }, scripts, dependencies: {} }, null, 2)}\n`;
}

const GITIGNORE = "node_modules/\ndist/\ndata/\n*.log\n.DS_Store\n";

function appConfig(spec) {
  const entities = spec.entities.map((entity) => ({
    name: entity.name,
    plural: pluralOf(entity.name),
    slug: slugOf(entity.name),
    // A booking is only useful with who and when, so those are required.
    fields: entity.name === "Booking" ? entity.fields.map((field) => (["name", "email", "date"].includes(field.key) ? { ...field, required: true } : field)) : entity.fields,
  }));
  const bookingEntity = entities.find((entity) => entity.name === "Booking");
  const booking = spec.pages?.some((page) => page.id === "book") && bookingEntity
    ? { entity: bookingEntity.slug, title: "Book an appointment", navLabel: "Book", intro: `Choose a service and a time that suits you, and ${spec.business ? `the ${spec.business.phrase}` : "we"} will confirm it.` }
    : null;
  return {
    name: spec.name,
    tagline: entities.length ? `${entities.map((entity) => entity.plural.toLowerCase()).join(" and ").replace(/^./u, (c) => c.toUpperCase())}, organised in one place.` : spec.name,
    theme: { accent: accentFor(spec) },
    home: booking ? "book" : "dashboard",
    booking,
    entities,
    ...backendConfig(spec),
  };
}

/** Which backend primitives the app turns on. Sign-in is on when the spec asks for email and password sign-in. */
function backendConfig(spec) {
  const password = Boolean(spec.auth?.required && spec.auth.method === "password");
  return {
    auth: { required: password, signup: "first-user" },
    files: { enabled: true, maxBytes: 10 * 1024 * 1024 },
    secrets: [...new Set((spec.integrations ?? []).flatMap((integration) => INTEGRATION_SECRETS[integration.id] ?? []))],
    jobs: password ? [{ name: "purge-expired-sessions", schedule: "17 * * * *" }] : [],
  };
}

function readme(spec, template, commands) {
  return `# ${spec.name}

${spec.objective}

Created by Atlas Genesis from the \`${template.id}\` template (v${template.version}).

## Run it

\`\`\`
${commands.map((line) => line).join("\n")}
\`\`\`

## What it does

${[...spec.workflows.map((flow) => `- ${flow.title}`), ...(spec.pages?.length ? [`- Pages: ${spec.pages.map((page) => page.title).join(", ")}`] : [])].join("\n")}

${template.shared.includes("src/auth.mjs") ? `## Built in

- **Sign-in** (\`src/auth.mjs\`): email and password, scrypt hashes, HttpOnly session cookies. ${spec.auth?.required && spec.auth.method === "password" ? "On: the first person to sign up becomes the owner and adds everyone else." : "Off: set \`auth.required\` to \`true\` in app.config.json to require it."}
- **Files** (\`src/files.mjs\`): uploads at \`/api/files\` with a size limit and checked file types, stored in \`data/files/\`.
- **Secrets** (\`src/secrets.mjs\`): \`node scripts/secret.mjs set NAME\` stores a key in \`data/secrets.json\` (git-ignored); an environment variable of the same name wins. Never sent to the browser.
- **Scheduled jobs** (\`src/jobs.mjs\`): cron schedules in app.config.json \`jobs\`, the work in server.mjs.
- **Background queue** (\`src/queue.mjs\`): durable jobs that survive restarts, deduplicate by key and retry with backoff; \`backend.queue.enqueue(kind, payload)\` with handlers passed as \`queueHandlers\`.

` : ""}## Assumptions

${spec.assumptions.map((line) => `- ${line}`).join("\n")}
`;
}

const TRADE_SERVICES = [
  [/roof/iu, [["Roof repairs", "Leaks, missing shingles and storm damage fixed fast."], ["Roof replacement", "Complete tear-off and new roof with a written warranty."], ["Inspections", "A clear report on your roof's condition, with photos."], ["Gutters", "Cleaning, repair and new gutter installation."]]],
  [/landscap|garden|lawn/iu, [["Lawn care", "Regular mowing, edging and feeding for a healthy lawn."], ["Garden design", "Planting plans that suit your space and your climate."], ["Hardscaping", "Patios, paths and retaining walls built to last."], ["Seasonal clean-ups", "Spring and autumn clean-ups, leaves and pruning."]]],
  [/construct|build|renovat|remodel/iu, [["New builds", "From plans to handover, managed by one team."], ["Renovations", "Kitchens, bathrooms and extensions done right."], ["Repairs", "Structural and general repairs, quoted up front."], ["Project management", "Schedules, permits and trades coordinated for you."]]],
  [/clean/iu, [["Regular cleaning", "Weekly or fortnightly cleans you can rely on."], ["Deep cleaning", "Top-to-bottom cleans for move-ins and special occasions."], ["Commercial cleaning", "Offices and shops cleaned outside your hours."], ["Windows", "Streak-free windows inside and out."]]],
  [/paint/iu, [["Interior painting", "Walls, ceilings and trim with a clean finish."], ["Exterior painting", "Weather-ready coatings that last."], ["Colour advice", "Help choosing colours that work together."], ["Repairs & prep", "Filling, sanding and priming done properly."]]],
];

function servicesFor(spec) {
  const trade = `${spec.business?.phrase ?? ""} ${spec.objective}`;
  const match = TRADE_SERVICES.find(([pattern]) => pattern.test(trade));
  const list = match ? match[1] : [["Consultations", "Talk through what you need and get honest advice."], ["Services", "Professional work delivered on time and on budget."], ["Support", "Friendly help before, during and after the job."], ["Quotes", "Clear, written quotes with no surprises."]];
  return list.map(([title, text]) => ({ title, text }));
}

function siteConfig(spec) {
  const who = spec.business?.kind ? `${spec.business.kind[0].toUpperCase()}${spec.business.kind.slice(1)}` : spec.name;
  const services = servicesFor(spec);
  const trade = spec.business?.phrase ?? "business";
  const pages = spec.pages.map((page) => {
    const base = { id: page.id, title: page.title };
    if (page.id === "home") return { ...base, headline: `${who} you can count on`, intro: `Dependable, professional ${spec.business?.kind ? `${spec.business.kind.toLowerCase()} ` : ""}work with clear quotes and friendly service.`, description: `${spec.name}: trusted ${trade} services. Get a free quote today.`.slice(0, 160), sections: [{ type: "cards", title: "What we do", items: services.slice(0, 3) }, { type: "steps", title: "How it works", items: [{ title: "Get in touch.", text: "Tell us what you need." }, { title: "Get a quote.", text: "We visit or call and send a clear price." }, { title: "Job done.", text: "We finish on schedule and tidy up after." }] }] };
    if (page.id === "services") return { ...base, headline: "Our services", intro: `Everything ${spec.name} can help you with.`, description: `Services offered by ${spec.name}.`.slice(0, 160), sections: [{ type: "cards", title: "Services", items: services }] };
    if (page.id === "about") return { ...base, headline: `About ${spec.name}`, intro: "Experienced, insured and focused on doing the job properly.", description: `About ${spec.name}: experience, values and service area.`.slice(0, 160), sections: [{ type: "text", title: "Our approach", paragraphs: ["We keep things simple: turn up on time, explain the options, and do work we are proud of.", "Every job gets a clear written quote before we start, and we stand behind our work."] }] };
    if (page.id === "gallery") return { ...base, headline: "Recent work", intro: "A few of the projects we have completed.", description: `Recent projects by ${spec.name}.`.slice(0, 160), sections: [{ type: "gallery", title: "Projects", items: services.map((service) => service.title), note: "Add your own project photos to replace these tiles." }] };
    if (page.id === "contact") return { ...base, headline: "Get a free quote", intro: "Send us a message and we will get back to you within one working day.", description: `Contact ${spec.name} for a free quote.`.slice(0, 160), sections: [{ type: "contact", title: "Contact us", text: "Tell us a little about the job and the best way to reach you." }] };
    return { ...base, headline: page.title, intro: page.purpose, description: `${page.title} · ${spec.name}`.slice(0, 160), sections: [{ type: "text", title: page.title, paragraphs: [page.purpose] }] };
  });
  return { name: spec.name, tagline: `Trusted ${trade} services`, cta: "Get a free quote", contact: { phone: "", email: "", area: "" }, theme: { accent: accentFor(spec) }, pages };
}

export const TEMPLATES = Object.freeze({
  "web-app": {
    id: "web-app",
    version: "1.1.0",
    title: "Full-stack web application",
    description: "Dashboard, record screens with search, add/edit/delete, status tracking and an optional public booking form, backed by a local SQLite file.",
    archetypes: ["webapp", "dashboard"],
    shared: [...COMMON_SHARED, "src/store.mjs", ...BACKEND],
    commands: { install: null, check: ["node", "scripts/check.mjs"], test: ["node", "--test", "--test-reporter=tap"], build: ["node", "scripts/build.mjs"] },
    preview: { prepare: null, command: ["node", "server.mjs"], env: { HOST: "127.0.0.1", PORT: "{port}" }, health: "/api/health", startupTimeoutMs: 15_000 },
    structure: { "server.mjs": "HTTP server and JSON API", "app.config.json": "record types, fields, pages, theme, sign-in, files, secrets and jobs", "public/": "the browser app", "src/": "storage, sign-in, files, secrets, jobs, validation and HTTP helpers", "tests/": "API tests for every record type", "scripts/": "check and build" },
    configure(spec) {
      const config = appConfig(spec);
      return {
        "app.config.json": `${JSON.stringify(config, null, 2)}\n`,
        "package.json": packageJson(spec, { start: "node server.mjs", dev: "node --watch server.mjs", check: "node scripts/check.mjs", test: "node --test --test-reporter=tap", build: "node scripts/build.mjs" }),
        "README.md": readme(spec, this, ["npm start        # http://127.0.0.1:3000", "npm test", "npm run build"]),
        ".gitignore": GITIGNORE,
      };
    },
  },
  "static-site": {
    id: "static-site",
    version: "1.0.0",
    title: "Business website",
    description: "Responsive multi-page site with SEO basics, a sitemap and a working enquiry form.",
    archetypes: ["website"],
    shared: COMMON_SHARED,
    commands: { install: null, check: ["node", "scripts/check.mjs"], test: ["node", "--test", "--test-reporter=tap"], build: ["node", "scripts/build.mjs"] },
    preview: { prepare: ["node", "scripts/build.mjs"], command: ["node", "server.mjs"], env: { HOST: "127.0.0.1", PORT: "{port}" }, health: "/api/health", startupTimeoutMs: 15_000 },
    structure: { "site.json": "pages, copy, contact details and theme", "scripts/build.mjs": "renders dist/", "server.mjs": "serves dist/ and records enquiries", "src/": "styles, form script, HTTP helpers", "tests/": "build and form tests" },
    configure(spec) {
      const site = siteConfig(spec);
      return {
        "site.json": `${JSON.stringify(site, null, 2)}\n`,
        "package.json": packageJson(spec, { start: "node scripts/build.mjs && node server.mjs", check: "node scripts/check.mjs", test: "node --test --test-reporter=tap", build: "node scripts/build.mjs" }),
        "README.md": readme(spec, this, ["npm start        # builds, then serves http://127.0.0.1:3000", "npm test", "npm run build     # static files in dist/"]),
        ".gitignore": GITIGNORE,
      };
    },
  },
  "api-service": {
    id: "api-service",
    version: "1.1.0",
    title: "REST API",
    description: "JSON API with create, list/search, read, update and delete for each record type, validation and a local SQLite file.",
    archetypes: ["api"],
    shared: [...COMMON_SHARED, "src/store.mjs", ...BACKEND],
    commands: { install: null, check: ["node", "scripts/check.mjs"], test: ["node", "--test", "--test-reporter=tap"], build: ["node", "scripts/build.mjs"] },
    preview: { prepare: null, command: ["node", "server.mjs"], env: { HOST: "127.0.0.1", PORT: "{port}" }, health: "/api/health", startupTimeoutMs: 15_000 },
    structure: { "server.mjs": "HTTP server and routes", "app.config.json": "record types, fields, sign-in, files, secrets and jobs", "src/": "storage, sign-in, files, secrets, jobs, validation and HTTP helpers", "tests/": "endpoint tests" },
    configure(spec) {
      const config = appConfig(spec);
      return {
        "app.config.json": `${JSON.stringify({ ...config, home: null, booking: null }, null, 2)}\n`,
        "package.json": packageJson(spec, { start: "node server.mjs", dev: "node --watch server.mjs", check: "node scripts/check.mjs", test: "node --test --test-reporter=tap", build: "node scripts/build.mjs" }),
        "README.md": readme(spec, this, ["npm start        # http://127.0.0.1:3000/api/…", "npm test"]),
        ".gitignore": GITIGNORE,
      };
    },
  },
});

export function getTemplate(id) {
  const template = TEMPLATES[id];
  if (!template) throw new Error(`Unknown Genesis template: ${id}`);
  return template;
}

function walk(directory, base = directory, out = []) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, base, out);
    else out.push(relative(base, path).split("\\").join("/"));
  }
  return out;
}

/** The template's own files plus the shared modules it declares, as { source, target } pairs. */
export function templateFiles(id) {
  const template = getTemplate(id);
  const own = walk(join(here, id, "files")).map((target) => ({ source: join(here, id, "files", target), target }));
  const shared = template.shared.map((entry) => (typeof entry === "string"
    ? { source: join(here, "shared", entry), target: entry }
    : { source: join(here, entry.from), target: entry.target }));
  return [...shared, ...own];
}
