import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { accentFor, siteConfig } from "./site-config.mjs";

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
    structure: { "site.json": "pages, copy, contact details and theme", "scripts/render.mjs": "pure page renderer shared with the hosted preview", "scripts/build.mjs": "writes dist/", "server.mjs": "serves dist/ and records enquiries", "src/": "styles, form script, HTTP helpers", "tests/": "build and form tests" },
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
