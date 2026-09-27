/**
 * From one sentence to a product specification Atlas can build and verify.
 *
 * The inference here is deliberately deterministic: the same prompt always
 * gives the same specification, every default is listed as an assumption the
 * owner can see and correct, and it works with no model at all. A model (the
 * Intelligence Layer, via intelligence.mjs) may refine the result, but the
 * shape and the rules below stay the contract.
 *
 * Questions are asked only when the answer changes architecture, cost,
 * permissions or behaviour in a way a default cannot safely cover: taking
 * payments, handling regulated data, or sending messages to real people. A
 * "website for my roofing company" gets pages, a lead form and SEO basics as
 * assumptions, not twenty questions.
 */

export const ARCHETYPES = Object.freeze(["website", "webapp", "dashboard", "api"]);

const words = (text) => String(text).toLowerCase();
const has = (text, pattern) => pattern.test(words(text));
const title = (text) => String(text).replace(/\s+/gu, " ").trim().replace(/\b\w/gu, (c) => c.toUpperCase());

const FIELD_WORDS = Object.freeze({
  name: { type: "text", required: true },
  email: { type: "email" },
  phone: { type: "tel" },
  status: { type: "select" },
  notes: { type: "textarea" },
  note: { type: "textarea", as: "notes" },
  address: { type: "text" },
  company: { type: "text" },
  title: { type: "text", required: true },
  description: { type: "textarea" },
  date: { type: "date" },
  time: { type: "time" },
  price: { type: "number" },
  amount: { type: "number" },
  value: { type: "number" },
  quantity: { type: "number" },
  sku: { type: "text" },
  location: { type: "text" },
  priority: { type: "select" },
  due: { type: "date", as: "dueDate" },
  service: { type: "text" },
  source: { type: "text" },
  stage: { type: "select" },
});

const STATUS_OPTIONS = Object.freeze({
  lead: ["New", "Contacted", "Qualified", "Won", "Lost"],
  customer: ["New", "Contacted", "Qualified", "Won", "Lost"],
  contact: ["New", "Contacted", "Qualified", "Won", "Lost"],
  booking: ["Requested", "Confirmed", "Completed", "Cancelled"],
  task: ["To do", "In progress", "Done"],
  deal: ["Prospect", "Estimate sent", "Negotiating", "Won", "Lost"],
  project: ["Planned", "In progress", "On hold", "Completed"],
  item: ["In stock", "Low", "Out of stock"],
  default: ["Open", "In progress", "Closed"],
});

/** Known domain shapes, used when the prompt names the kind of tool but not its fields. */
const DOMAIN_ENTITIES = Object.freeze({
  crm: [
    { name: "Contact", fields: ["name", "company", "email", "phone", "status", "notes"] },
    { name: "Deal", fields: ["title", "value", "stage", "notes"] },
  ],
  booking: [{ name: "Booking", fields: ["name", "email", "phone", "service", "date", "time", "notes", "status"] }],
  inventory: [{ name: "Item", fields: ["name", "sku", "quantity", "location", "status"] }],
  task: [{ name: "Task", fields: ["title", "status", "priority", "due", "notes"] }],
  lead: [{ name: "Lead", fields: ["name", "email", "phone", "status", "notes"] }],
  store: [
    { name: "Product", fields: ["name", "description", "price", "quantity", "status"] },
    { name: "Order", fields: ["name", "email", "phone", "notes", "status"] },
  ],
});

function singular(noun) {
  const n = noun.toLowerCase();
  if (n.endsWith("ies")) return `${n.slice(0, -3)}y`;
  if (n.endsWith("ses") || n.endsWith("xes")) return n.slice(0, -2);
  if (n.endsWith("s") && !n.endsWith("ss")) return n.slice(0, -1);
  return n;
}

function businessType(prompt) {
  const match = /\bfor (?:my|our|a|an|the)\s+((?:[a-z-]+\s){0,3}?)(company|business|shop|studio|agency|firm|practice|restaurant|salon|clinic|team|store|gym|bakery|cafe|church|school|nonprofit)\b/iu.exec(prompt);
  if (!match) return null;
  const kind = match[1].trim();
  return { kind: kind || null, noun: match[2].toLowerCase(), phrase: `${kind ? `${kind} ` : ""}${match[2]}`.toLowerCase() };
}

function explicitName(prompt) {
  const match = /\b(?:called|named)\s+["“]?([A-Z0-9][\w&' .-]{1,60}?)["”]?(?:[.,;]|\s+(?:for|with|that|which)\b|$)/u.exec(prompt);
  return match ? match[1].trim() : null;
}

function classify(prompt) {
  const reasons = [];
  let archetype = "webapp";
  const api = has(prompt, /\b(rest(ful)? api|api|endpoints?|backend service|microservice|webhook)\b/u) && !has(prompt, /\b(website|web ?site|dashboard|page)\b/u);
  const dashboard = has(prompt, /\b(dashboard|analytics|metrics|kpis?|reports?|internal tool|admin panel)\b/u);
  const records = has(prompt, /\b(crm|tracker|tracking|manager|management|inventory|database|log|booking|bookings|appointments?|reservations?|schedul\w*|orders?|to-?do|tasks?|add (a |an )?\w+|search)\b/u);
  const site = has(prompt, /\b(website|web ?site|landing page|home ?page|marketing site|portfolio|site)\b/u);
  if (api) { archetype = "api"; reasons.push("asks for an API rather than pages"); }
  else if (records) { archetype = "webapp"; reasons.push("people add, change and find records"); }
  else if (dashboard) { archetype = "dashboard"; reasons.push("mainly shows figures and lists"); }
  else if (site) { archetype = "website"; reasons.push("a public site that presents a business"); }
  else reasons.push("general application: pages plus stored records");
  return { archetype, reasons };
}

function detectFields(prompt) {
  const found = [];
  const text = words(prompt);
  for (const [word, info] of Object.entries(FIELD_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, "u").test(text)) {
      const key = info.as ?? word;
      if (!found.includes(key)) found.push(key);
    }
  }
  return found;
}

function field(key, entityName) {
  const info = Object.values(FIELD_WORDS).find((value) => (value.as ?? null) === key) ?? FIELD_WORDS[key] ?? { type: "text" };
  const label = key === "dueDate" ? "Due date" : title(key);
  const result = { key, label, type: info.type, required: Boolean(info.required) };
  if (info.type === "select") result.options = STATUS_OPTIONS[singular(entityName)] ?? STATUS_OPTIONS.default;
  return result;
}

function detectEntities(prompt, archetype) {
  if (archetype === "website") return [];
  // "for my construction company" describes the owner, not a field to store.
  const text = words(prompt).replace(/\bfor (?:my|our|a|an|the)\s+(?:[a-z-]+\s){0,3}?(?:company|business|shop|studio|agency|firm|practice|restaurant|salon|clinic|team|store|gym|bakery|cafe|church|school|nonprofit)\b/gu, " ");
  const fields = detectFields(text);
  let base = null;
  if (/\bcrm\b|customer relationship/u.test(text)) base = DOMAIN_ENTITIES.crm;
  else if (/\b(booking|bookings|appointments?|reservations?|schedul\w*)\b/u.test(text)) base = DOMAIN_ENTITIES.booking;
  else if (/\binventory|stock\b/u.test(text)) base = DOMAIN_ENTITIES.inventory;
  else if (/\b(to-?do|tasks?)\b/u.test(text)) base = DOMAIN_ENTITIES.task;
  else if (/\b(online store|shop|products?|catalog(ue)?|orders?)\b/u.test(text)) base = DOMAIN_ENTITIES.store;

  // "add customer", "customer tracker", "lead tracker": the named record wins.
  const added = /\badd (?:a |an |new )?([a-z]+)\b/u.exec(text)?.[1];
  const tracked = /\b([a-z]+)\s+(?:tracker|manager|list|log|database|directory|register)\b/u.exec(text)?.[1];
  const named = [added, tracked].map((noun) => (noun ? singular(noun) : null)).find((noun) => noun && !["simple", "small", "basic", "new", "the", "my", "a", "an"].includes(noun));

  if (named && fields.length) {
    const keys = fields.includes("name") || fields.includes("title") ? fields : ["name", ...fields];
    return [{ name: title(named), fields: keys }];
  }
  if (base) {
    if (!fields.length) return base;
    const [first, ...rest] = base;
    return [{ ...first, fields: [...new Set([...first.fields, ...fields])] }, ...rest];
  }
  if (named) return [{ name: title(named), fields: ["name", "status", "notes"] }];
  if (archetype === "dashboard") return [{ name: "Record", fields: ["title", "value", "status", "date"] }];
  return [{ name: "Item", fields: ["title", "description", "status"] }];
}

function detectAuth(prompt, archetype) {
  const google = has(prompt, /\bgoogle (login|sign[- ]?in|auth)|sign in with google\b/u);
  const github = has(prompt, /\bgithub (login|sign[- ]?in)\b/u);
  const explicit = google || github || has(prompt, /\b(log ?in|sign ?in|sign ?up|accounts?|authenticat\w*|password|members?(hip)?|user roles?|admin(istrator)? (area|panel|only)|private|only (me|my team|staff))\b/u);
  if (explicit) {
    return { required: true, method: google ? "google" : github ? "github" : "password", reason: "the request mentions sign-in or private access" };
  }
  if (archetype === "webapp" || archetype === "dashboard") {
    return { required: false, method: "none", reason: "runs on your computer for you; add sign-in before publishing it to others" };
  }
  return { required: false, method: "none", reason: "public pages need no sign-in" };
}

function detectIntegrations(prompt) {
  const list = [];
  if (has(prompt, /\b(pay(ments?)?|checkout|stripe|paypal|invoice|deposits?|charge)\b/u)) list.push({ id: "payments", label: "Online payments", needs: "a payment provider account and keys" });
  // "name/email/phone" is a field, not a request to send email.
  if (has(prompt, /\b(notify|notifications?|newsletters?|reminders?|send (an? )?e-?mails?|e-?mail (me|them|customers|clients|reminders|alerts|confirmations?))\b/u)) list.push({ id: "email", label: "Email notifications", needs: "an email sending service" });
  if (has(prompt, /\b(sms|text message)\b/u)) list.push({ id: "sms", label: "Text messages", needs: "an SMS provider" });
  if (has(prompt, /\bgoogle (login|sign[- ]?in|auth)|sign in with google\b/u)) list.push({ id: "google-oauth", label: "Google sign-in", needs: "a Google OAuth client" });
  if (has(prompt, /\b(maps?|directions)\b/u)) list.push({ id: "maps", label: "Map link", needs: "nothing (a link to the address)" });
  if (has(prompt, /\bcalendar|google calendar|ical\b/u)) list.push({ id: "calendar", label: "Calendar export", needs: "nothing for .ics files; an account for live sync" });
  return list;
}

function detectDesign(prompt) {
  const colours = ["blue", "green", "red", "orange", "purple", "teal", "black", "dark", "earthy", "warm"].filter((colour) => has(prompt, new RegExp(`\\b${colour}\\b`, "u")));
  const styles = ["minimal", "modern", "playful", "elegant", "bold", "rustic", "professional"].filter((style) => has(prompt, new RegExp(`\\b${style}\\b`, "u")));
  return {
    style: styles.length ? styles.join(", ") : "clean and professional",
    colours: colours.length ? colours : null,
    notes: ["responsive from phone to desktop", "readable contrast and visible focus states", "real copy, no lorem ipsum"],
  };
}

function websitePages(business) {
  const pages = [
    { id: "home", title: "Home", purpose: "Who the business is and a clear call to action" },
    { id: "services", title: "Services", purpose: "What the business offers" },
    { id: "about", title: "About", purpose: "Story, experience and trust signals" },
    { id: "contact", title: "Contact", purpose: "Lead form, phone, email and service area" },
  ];
  if (business && /landscap|garden|roof|construct|paint|clean|renovat|remodel|plumb|electric|photograph|design|bak|salon/iu.test(business.phrase)) {
    pages.splice(3, 0, { id: "gallery", title: "Gallery", purpose: "Photos of past work" });
  }
  return pages;
}

function appPages(entities, archetype, booking) {
  const pages = [{ id: "dashboard", title: "Dashboard", purpose: "Counts and recent activity at a glance" }];
  for (const entity of entities) pages.push({ id: `${entity.name.toLowerCase()}s`, title: `${entity.name}s`, purpose: `List, search, add and edit ${entity.name.toLowerCase()}s` });
  if (booking) pages.unshift({ id: "book", title: "Book", purpose: "Public booking form for customers" });
  if (archetype === "dashboard") pages[0].purpose = "Key figures, charts and recent records";
  return pages;
}

function workflowsFor({ archetype, entities, booking, auth, pages }) {
  const flows = [];
  if (archetype === "website") {
    flows.push({ id: "browse", title: "Browse the site", steps: pages.map((page) => `Open ${page.title}`) });
    flows.push({ id: "lead", title: "Send an enquiry", steps: ["Open Contact", "Fill in name, email, phone and message", "Submit", "See a confirmation"] });
    return flows;
  }
  if (archetype === "api") {
    for (const entity of entities) flows.push({ id: `${entity.name.toLowerCase()}-crud`, title: `Manage ${entity.name.toLowerCase()}s over HTTP`, steps: ["POST to create", "GET to list and filter", "GET one by id", "PATCH to update", "DELETE to remove"] });
    return flows;
  }
  if (auth.required) flows.push({ id: "sign-in", title: "Sign in", steps: ["Open the app", "Sign in", "Land on the dashboard"] });
  if (booking) flows.push({ id: "book", title: "Book an appointment", steps: ["Open Book", "Choose a service, date and time", "Enter contact details", "Submit", "See a confirmation"] });
  for (const entity of entities) {
    const plural = `${entity.name.toLowerCase()}s`;
    flows.push({ id: `add-${entity.name.toLowerCase()}`, title: `Add a ${entity.name.toLowerCase()}`, steps: [`Open ${entity.name}s`, "Choose Add", `Fill in ${entity.fields.slice(0, 4).join(", ")}`, "Save", "See it in the list"] });
    flows.push({ id: `find-${entity.name.toLowerCase()}`, title: `Find ${plural}`, steps: [`Open ${entity.name}s`, "Type in search", "See matching rows only"] });
    if (entity.fields.includes("status") || entity.fields.includes("stage")) flows.push({ id: `update-${entity.name.toLowerCase()}`, title: `Update a ${entity.name.toLowerCase()}'s status`, steps: ["Open one", "Change status", "Save", "See the new status"] });
  }
  flows.push({ id: "overview", title: "See the overview", steps: ["Open Dashboard", "See counts by status"] });
  return flows;
}

function acceptance({ archetype, pages, workflows, entities, auth }) {
  const criteria = [
    "Installs and builds with no errors",
    "Automated tests pass",
    "Every page loads without a runtime error or console error",
    "Layout works at 375px (phone) and 1280px (desktop) widths",
  ];
  if (archetype === "api") {
    criteria.splice(2, 2, "Every endpoint returns JSON with correct status codes", "Invalid input is rejected with a 400 and a message");
    for (const entity of entities) criteria.push(`${entity.name} records can be created, listed, read, updated and deleted`);
    return criteria;
  }
  for (const page of pages) criteria.push(`${page.title} page shows its heading and content`);
  for (const flow of workflows.filter((w) => w.id !== "browse")) criteria.push(`"${flow.title}" works end to end`);
  for (const entity of entities.filter((e) => e.fields.some((f) => f.required))) criteria.push(`${entity.name} form rejects a missing ${entity.fields.find((f) => f.required).label.toLowerCase()}`);
  if (auth.required) criteria.push("Private pages are unreachable without signing in");
  return criteria;
}

function questionsFor({ prompt, integrations }) {
  const questions = [];
  if (integrations.some((i) => i.id === "payments")) {
    questions.push({ id: "payments", question: "Should customers pay online? Online payments need your own payment account (for example Stripe) and may cost fees. If not, Atlas records the price and you collect payment yourself.", default: "no", materialBecause: "cost and credentials" });
  }
  if (has(prompt, /\b(patients?|medical|health records?|hipaa|diagnos\w*|prescriptions?)\b/u)) {
    questions.push({ id: "regulated-data", question: "Will this store medical or health information about real people? That changes how the data must be stored and who may access it.", default: "no", materialBecause: "regulated data" });
  }
  if (has(prompt, /\b(send|email|text|sms)\b.*\b(customers?|clients?|leads?|everyone|list)\b/u)) {
    questions.push({ id: "outbound-messages", question: "Should the app send emails or texts to your customers automatically? Atlas will build it to draft messages for you to send unless you say yes.", default: "draft only", materialBecause: "messages to real people" });
  }
  return questions;
}

/**
 * @param {string} prompt
 * @param {{ answers?: Record<string, string> }} [options]
 */
export function inferSpecification(prompt, { answers = {} } = {}) {
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("Describe what to build.");
  const business = businessType(text);
  const { archetype, reasons } = classify(text);
  const booking = has(text, /\b(booking|bookings|book|appointments?|reservations?|schedul\w*)\b/u);
  const entityDefs = detectEntities(text, archetype);
  const entities = entityDefs.map((entity) => ({ name: entity.name, fields: entity.fields.map((key) => field(key, entity.name)) }));
  const auth = detectAuth(text, archetype);
  const integrations = detectIntegrations(text);
  const pages = archetype === "website" ? websitePages(business) : archetype === "api" ? [] : appPages(entities, archetype, booking);
  const workflows = workflowsFor({ archetype, entities, booking, auth, pages });
  const kindLabel = {
    // A site is named like the business it presents ("Roofing Company"), not "Website".
    website: business ? title(business.noun) : "Website",
    webapp: /\bcrm\b/iu.test(text) ? "CRM" : booking ? "Bookings" : /\b(online store|shop)\b/iu.test(text) ? "Store" : entities[0] ? `${entities[0].name} Tracker` : "App",
    dashboard: `${/\b([a-z]+) dashboard\b/iu.exec(text)?.[1] && !/^(a|an|the|simple|small|my|our)$/iu.test(/\b([a-z]+) dashboard\b/iu.exec(text)[1]) ? `${/\b([a-z]+) dashboard\b/iu.exec(text)[1]} ` : ""}Dashboard`,
    api: `${entities[0] ? `${entities[0].name} ` : ""}API`,
  }[archetype];
  const qualifier = business?.kind ?? (business && !["company", "business", "team", "firm", "store", "shop"].includes(business.noun) ? business.noun : null);
  const name = explicitName(text) ?? (archetype === "website" && business ? title(business.phrase) : title(`${qualifier ? `${qualifier} ` : ""}${kindLabel}`));
  const questions = questionsFor({ prompt: text, integrations }).filter((q) => !(q.id in answers));

  const assumptions = [
    `Built as a ${archetype === "website" ? "responsive website" : archetype === "api" ? "JSON HTTP API" : "web application"} because it ${reasons[0]}.`,
    "Runs on this computer with a local preview. Publishing is a separate step that asks you first.",
    auth.required ? `Sign-in with ${auth.method === "password" ? "email and password" : auth.method}.` : `No sign-in: ${auth.reason}.`,
  ];
  if (archetype === "website") assumptions.push("Pages: Home, Services, About, Contact (plus Gallery for trades that show their work). Contact has a lead form.", "Includes SEO basics: page titles, descriptions and a sitemap.");
  if (entities.length) assumptions.push(`Stores ${entities.map((e) => `${e.name.toLowerCase()}s (${e.fields.map((f) => f.key).join(", ")})`).join(" and ")} in a local database file.`);
  for (const integration of integrations) assumptions.push(`${integration.label} needs ${integration.needs}; Atlas builds it switched off until you connect one.`);
  for (const [id, answer] of Object.entries(answers)) assumptions.push(`You answered ${id}: ${String(answer).slice(0, 200)}.`);

  return {
    version: 1,
    name,
    objective: text,
    archetype,
    business: business ? { kind: business.kind, noun: business.noun, phrase: business.phrase } : null,
    targetUsers: archetype === "website"
      ? `Prospective customers of ${business ? `your ${business.phrase}` : "the business"}`
      : `${business ? `Your ${business.phrase}` : "You and your team"}${booking ? ", and customers who book" : ""}`,
    pages,
    workflows,
    entities,
    auth,
    integrations,
    design: detectDesign(text),
    deployment: { target: "local", preview: true, publish: has(text, /\b(deploy|publish|go live|online|domain|host(ed|ing)?)\b/u) ? "requested after the app is ready (asks first)" : "optional, asks first" },
    constraints: ["No paid services or external accounts without your approval", "Your data stays on this computer until you publish"],
    acceptanceCriteria: acceptance({ archetype, pages, workflows, entities, auth }),
    assumptions,
    questions,
    answers,
  };
}

/**
 * A change request against an existing specification ("Add Google login").
 * Returns the updated spec plus a short list of what changed, so the plan can
 * add only the tasks the change needs.
 */
export function applyChangeRequest(spec, request) {
  const text = String(request ?? "").trim();
  if (!text) throw new Error("Describe the change.");
  const next = structuredClone(spec);
  const changes = [];
  const auth = detectAuth(text, spec.archetype);
  if (auth.required && (!spec.auth.required || spec.auth.method !== auth.method)) {
    next.auth = { required: true, method: auth.method, reason: "requested as a change" };
    changes.push({ kind: "auth", summary: `Add ${auth.method === "password" ? "email and password" : auth.method} sign-in` });
    next.acceptanceCriteria = [...new Set([...next.acceptanceCriteria, "Private pages are unreachable without signing in"])];
  }
  for (const integration of detectIntegrations(text)) {
    if (!next.integrations.some((existing) => existing.id === integration.id)) {
      next.integrations.push(integration);
      changes.push({ kind: "integration", summary: `Add ${integration.label.toLowerCase()}` });
    }
  }
  const addedFields = detectFields(text).filter((key) => next.entities[0] && !next.entities[0].fields.some((f) => f.key === key));
  if (addedFields.length && next.entities[0] && /\b(add|include|track|store|field|column)\b/iu.test(text)) {
    next.entities[0].fields.push(...addedFields.map((key) => field(key, next.entities[0].name)));
    changes.push({ kind: "fields", summary: `Add ${addedFields.join(", ")} to ${next.entities[0].name}` });
  }
  if (!changes.length) changes.push({ kind: "feature", summary: text.slice(0, 300) });
  next.changeLog = [...(spec.changeLog ?? []), { request: text, changes }];
  next.version = (spec.version ?? 1) + 1;
  return { spec: next, changes };
}
