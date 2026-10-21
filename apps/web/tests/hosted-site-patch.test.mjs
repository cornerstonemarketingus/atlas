import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { PATCH_LIMITS, UPDATE_PROJECT_TOOL, validatePatch } from "../app/api/genesis/hosted-site-patch.mjs";

const ID = "gen_00000001-aaaa-4bbb-8ccc-dddddddddddd";
const SAID = "My number is (651) 555-0142 and email is pat@hahnbuilds.com. We are licensed and insured in Minnesota. We started in 2009. Service area is the south metro.";

/** The hostile battery: every case states what a correct validator must do. Returns the expectations that failed. */
export function findings(validate) {
  const failed = [];
  const run = (label, patch, message, expectOk, expectCode) => {
    let result;
    try { result = validate({ projectId: ID, ...patch }, { userMessage: message }); } catch (error) { failed.push(`${label}: threw ${error.message}`); return; }
    if (result.ok !== expectOk) failed.push(`${label}: expected ok=${expectOk}`);
    else if (!expectOk && expectCode && !result.errors.some((error) => error.code === expectCode)) failed.push(`${label}: expected ${expectCode}, got ${result.errors.map((error) => error.code)}`);
  };
  run("good contact", { contact: { phone: "(651) 555-0142", email: "pat@hahnbuilds.com", area: "the south metro" } }, SAID, true);
  run("unknown top-level field", { tagline: "Framing", html: "x" }, SAID, false, "unknown_field");
  run("unknown nested field", { contact: { phone: "(651) 555-0142", fax: "1" } }, SAID, false, "unknown_field");
  run("proto key", JSON.parse('{"__proto__":{"x":1},"tagline":"Framing"}'), SAID, false, "unknown_field");
  run("html in tagline", { tagline: "<script>alert(1)</script>" }, SAID, false, "characters");
  run("html entity in tagline", { tagline: "Framing &lt;b&gt;" }, SAID, true);
  run("bracket placeholder text", { pageText: [{ slot: "story", text: "[Add story here]" }] }, SAID, false, "characters");
  run("javascript url", { tagline: "javascript:alert(1)" }, SAID, false, "url");
  run("http url", { tagline: "See https://evil.example now" }, SAID, false, "url");
  run("bare domain", { tagline: "Visit evil.com today" }, SAID, false, "url");
  run("protocol-relative", { tagline: "Go to //evil" }, SAID, false, "url");
  run("huge string", { tagline: "a".repeat(100_000) }, SAID, false, "too_long");
  run("slightly long", { tagline: "a".repeat(PATCH_LIMITS.tagline + 1) }, SAID, false, "too_long");
  run("bad phone", { contact: { phone: "call me maybe" } }, SAID, false, "phone");
  run("short phone", { contact: { phone: "12345" } }, "12345", false, "phone");
  run("phone with markup", { contact: { phone: "651<b>5550142" } }, SAID, false, "phone");
  run("invented phone", { contact: { phone: "(612) 555-0199" } }, SAID, false, "unsupported_contact");
  run("bad email", { contact: { email: "pat@@x" } }, "pat@@x", false, "email");
  run("email with mailto", { contact: { email: "mailto:pat@hahnbuilds.com" } }, SAID, false, "email");
  run("double dot email", { contact: { email: "pat..x@hahnbuilds.com" } }, "pat..x@hahnbuilds.com", false, "email");
  run("invented email", { contact: { email: "owner@hahnbuilds.com" } }, SAID, false, "unsupported_contact");
  run("clear phone", { contact: { phone: null } }, "remove my phone", true);
  run("invented licence", { pageText: [{ slot: "credentials", text: "Licensed contractor number 12345 and fully bonded." }] }, SAID, false, "unsupported_claim");
  run("invented credentials with no claim words", { pageText: [{ slot: "credentials", text: "Our crew is friendly and tidy." }] }, SAID, false, "unsupported_claim");
  run("stated credentials", { pageText: [{ slot: "credentials", text: "We are licensed and insured in Minnesota." }] }, SAID, true);
  run("negated credential", { pageText: [{ slot: "credentials", text: "Licensed and insured." }] }, "We are not licensed and insured yet.", false, "unsupported_claim");
  run("invented years", { pageText: [{ slot: "story", text: "Family-owned for over 25 years." }] }, SAID, false, "unsupported_claim");
  run("invented testimonial", { pageText: [{ slot: "story", text: "\"Best framers ever\" says a happy customer." }] }, SAID, false, "unsupported_claim");
  run("invented number in a tagline", { tagline: "Over 500 homes framed" }, SAID, false, "unsupported_claim");
  run("stated year", { pageText: [{ slot: "story", text: "We started in 2009." }] }, SAID, true);
  run("claim in a tagline", { tagline: "Fully insured framing crew" }, "Please add a tagline: framing in the south metro", false, "unsupported_claim");
  run("claim in a service description", { addServices: [{ title: "Decks", description: "Award-winning decks." }] }, "Add decks as a service", false, "unsupported_claim");
  run("invented claim in the business name", { businessName: "Licensed Hahn Framing" }, "Rename it to Hahn Framing", false, "unsupported_claim");
  run("plain story", { pageText: [{ slot: "story", text: "We frame houses in the south metro." }] }, "We frame houses in the south metro.", true);
  run("control chars stripped", { tagline: "Wood\u0000 fram‮ing" }, SAID, true);
  run("page outside the set", { addPages: ["admin"] }, SAID, false, "enum");
  run("cannot remove contact", { removePages: ["contact"] }, SAID, false, "enum");
  run("cannot remove home", { removePages: ["home"] }, SAID, false, "enum");
  run("add and remove same page", { addPages: ["about"], removePages: ["about"] }, SAID, false, "conflict");
  run("slot outside the set", { pageText: [{ slot: "footer", text: "hi" }] }, SAID, false, "enum");
  run("page given for story", { pageText: [{ slot: "story", page: "contact", text: "hi there" }] }, SAID, false, "page");
  run("string where object expected", { contact: "phone" }, SAID, false, "type");
  run("array where string expected", { tagline: ["a"] }, SAID, false, "type");
  run("empty patch", {}, SAID, false, "empty");
  run("empty contact", { contact: {} }, SAID, false, "empty");
  run("bad project id", { projectId: "../../etc" }, SAID, false, "project_id");
  return failed;
}

test("the validator accepts what the person said and rejects every hostile case", () => {
  assert.deepEqual(findings(validatePatch), []);
});

test("accepted text is normalised: control characters and invisible characters are removed", () => {
  const result = validatePatch({ projectId: ID, tagline: "  Wood\u0000 fram‮ing​\n crew " }, { userMessage: "" });
  assert.equal(result.ok, true);
  assert.equal(result.patch.tagline, "Wood framing crew");
});

test("the output is a rebuilt copy: no field the model sent survives except the validated ones", () => {
  const result = validatePatch({ projectId: ID, contact: { phone: "(651) 555-0142" } }, { userMessage: SAID });
  assert.deepEqual(result.patch, { projectId: ID, contact: { phone: "(651) 555-0142" } });
});

test("the tool definition is strict at every level and matches the validator's fields", () => {
  const { parameters } = UPDATE_PROJECT_TOOL.function;
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.required, ["projectId"]);
  assert.equal(parameters.properties.contact.additionalProperties, false);
  assert.equal(parameters.properties.pageText.items.additionalProperties, false);
  assert.equal(parameters.properties.addServices.items.additionalProperties, false);
  assert.deepEqual(parameters.properties.addPages.items.enum, ["services", "about", "gallery"]);
});

// Mutation check: weakening any guard must be caught by the battery above.
const MUTATIONS = {
  "unknown fields allowed": ["for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(", "for (const key of Object.keys(value)) if (false) fail("],
  "length limit removed": ["if (clean.length > max) return fail(", "if (false) return fail("],
  "charset check removed": ["if (!chars.test(clean)) return fail(", "if (false) return fail("],
  "url check removed": ["if (URL_LIKE.test(clean)) return fail(", "if (false) return fail("],
  "claim guard removed": ["if (claims) { const reason", "if (false) { const reason"],
  "negation ignored": ["!NEGATION.test(message.slice(Math.max(0, at - 45), at))", "true"],
  "number guard removed": ["for (const number of text.match(/\\p{N}+/gu) ?? []) {", "for (const number of []) {"],
  "credentials not always a claim": ["allClaims: item.slot === \"credentials\"", "allClaims: false"],
  "phone format removed": ["if (!/^\\+?[0-9 ().-]{7,24}$/u.test(clean) ||", "if (false ||"],
  "phone grounding removed": ["if (!message.replace(/\\D+/gu, \"\").includes(digits)) {", "if (false) {"],
  "email format removed": ["if (clean.length > 120 || clean.includes(\"..\") ||", "if (false ||"],
  "email grounding removed": ["if (!message.toLowerCase().includes(clean.toLowerCase())) {", "if (false) {"],
  "page set widened": ["!root[key].every((page) => EDITABLE_PAGES.includes(page))", "false"],
  "control characters kept": ["String(value).replace(/[\\t\\n\\r]+/gu, \" \").replace(ANY_CONTROL, \"\")", "String(value)"],
};

test("mutation check: each weakened validator fails the hostile battery", async () => {
  const source = readFileSync(new URL("../app/api/genesis/hosted-site-patch.mjs", import.meta.url), "utf8");
  const directory = mkdtempSync(path.join(tmpdir(), "patch-mutants-"));
  let index = 0;
  for (const [name, [from, to]] of Object.entries(MUTATIONS)) {
    assert.ok(source.includes(from), `mutation "${name}" no longer matches the source; update the test`);
    assert.equal(source.split(from).length, 2, `mutation "${name}" must match exactly once`);
    const file = path.join(directory, `mutant-${index++}.mjs`);
    writeFileSync(file, source.replace(from, to));
    const mutant = await import(pathToFileURL(file).href);
    assert.notDeepEqual(findings(mutant.validatePatch), [], `weakening "${name}" went unnoticed`);
  }
});
