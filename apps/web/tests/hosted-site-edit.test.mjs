import assert from "node:assert/strict";
import test from "node:test";
import { hostedSiteStore } from "../db/hosted-sites.mjs";
import { createHostedSite, renderPreviewFile, resultFromRow } from "../app/api/genesis/hosted-site.mjs";
import { applyPatch, updateHostedSite } from "../app/api/genesis/hosted-site-edit.mjs";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";

const HAHN = "Build a responsive website for Team Hahn Construction in Eagan, Minnesota, specializing in wood framing, windows, doors, and housewrap.";
const uuid = (n = 1) => `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`;
const scope = { tenantId: 1, principal: "github:owner" };
const SAID = "Use phone (651) 555-0142 and email pat@hahnbuilds.com, service area is Dakota County. We are licensed and insured in Minnesota. We started the company in 2009 after years of framing.";

async function seeded() {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "owner"]] });
  sqlite.prepare("INSERT INTO tenants (id, slug, name, owner_principal) VALUES (2, 'other', 'Other', 'github:other')").run();
  const store = hostedSiteStore(d1);
  const created = await createHostedSite({ store, scope, requestId: uuid(), userMessage: HAHN });
  assert.equal(created.status, "ready");
  const edit = (input, userMessage = SAID, extra = {}) => updateHostedSite({ store, scope, userMessage, input: { projectId: created.projectId, ...input }, ...extra });
  const row = () => sqlite.prepare("SELECT * FROM genesis_projects WHERE id = ?").get(created.projectId);
  return { sqlite, d1, store, created, edit, row };
}

test("filling in the phone, email and area is saved, re-verified, and the placeholder count and preview URL are honest", async () => {
  const { store, created, edit, row } = await seeded();
  const before = row();
  const result = await edit({ contact: { phone: "(651) 555-0142", email: "pat@hahnbuilds.com", area: "Dakota County" } });
  assert.equal(result.status, "ready", result.message);
  assert.equal(result.edited, true);
  assert.equal(result.previewUrl, created.previewUrl);
  assert.deepEqual(result.changes.map((change) => change.field), ["contact.phone", "contact.email", "contact.area"]);
  assert.equal(result.verification.browserChecks, "not-run");
  assert.equal(result.verification.enquiryDelivery, "preview-only");
  assert.equal(result.deploymentState, "not-deployed");
  assert.match(result.message, /nothing is published/iu);
  const after = row();
  assert.equal(after.id, before.id); assert.equal(after.preview_url, before.preview_url);
  assert.notEqual(after.updated_at, before.updated_at);
  assert.equal(after.created_at, before.created_at);
  const evidence = JSON.parse(after.evidence_json);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[1].ok, true); assert.deepEqual(evidence[1].edit.changes, ["contact.phone", "contact.email", "contact.area"]);
  // The preview renders the new facts as tel:/mailto: links, escaped, and the status poll reports the new state.
  const contact = renderPreviewFile(await store.get(scope, created.projectId), "contact.html").body;
  assert.match(contact, /<a href="tel:\(651\) 555-0142">\(651\) 555-0142<\/a>/u);
  assert.match(contact, /<a href="mailto:pat@hahnbuilds.com">/u);
  assert.match(contact, /Service area: Dakota County/u);
  assert.equal(resultFromRow(await store.get(scope, created.projectId)).verification.ownerContentNeeded, evidence[1].ownerContentNeeded);
});

test("replacing the story and credentials drops the placeholder count only by what was filled", async () => {
  const { created, edit } = await seeded();
  const start = created.verification.ownerContentNeeded;
  const story = await edit({ pageText: [{ slot: "story", text: "We started the company in 2009 after years of framing." }] });
  assert.equal(story.status, "ready", story.message);
  assert.equal(story.remainingPlaceholders, start - 1);
  const credentials = await edit({ pageText: [{ slot: "credentials", text: "We are licensed and insured in Minnesota." }] });
  assert.equal(credentials.status, "ready", credentials.message);
  assert.equal(credentials.remainingPlaceholders, start - 2);
});

test("an invented credential is rejected and nothing is saved", async () => {
  const { edit, row } = await seeded();
  const before = row();
  const result = await edit({ pageText: [{ slot: "credentials", text: "Licensed, bonded and insured since 1995, A+ BBB rating." }] });
  assert.equal(result.status, "failed");
  assert.equal(result.code, "INVALID_PATCH");
  assert.deepEqual(row(), before);
});

test("hostile input is rejected before anything is read or written", async () => {
  const { edit, row } = await seeded();
  const before = row();
  for (const input of [
    { tagline: "<img src=x onerror=alert(1)>" }, { tagline: "a".repeat(200_000) }, { extra: true, tagline: "ok" },
    { contact: { email: "x@y.z\"><script>" } }, { pageText: [{ slot: "story", text: "visit http://evil.test" }] }, { removePages: ["contact"] },
  ]) {
    const result = await edit(input);
    assert.equal(result.status, "failed", JSON.stringify(input).slice(0, 60));
    assert.equal(result.code, "INVALID_PATCH");
  }
  assert.deepEqual(row(), before);
});

test("another workspace or principal cannot edit the site, and cannot tell it exists", async () => {
  const { store, created, row } = await seeded();
  const before = row();
  for (const other of [{ tenantId: 2, principal: "github:owner" }, { tenantId: 1, principal: "github:someone-else" }]) {
    const result = await updateHostedSite({ store, scope: other, userMessage: SAID, input: { projectId: created.projectId, tagline: "Framing in Dakota County" } });
    assert.equal(result.status, "not-found");
  }
  assert.deepEqual(row(), before);
  assert.equal(await store.update({ tenantId: 2, principal: "github:owner" }, { id: created.projectId, expectedUpdatedAt: before.updated_at, name: "x", requirementsJson: "{}", evidenceJson: "[]", updatedAt: "2099-01-01T00:00:00.000Z" }), false);
  assert.deepEqual(row(), before);
});

test("a stale basedOn is refused, and so is a write that loses a race", async () => {
  const { store, created, edit, row } = await seeded();
  const first = await edit({ tagline: "Framing in Dakota County" });
  assert.equal(first.status, "ready", first.message);
  const stale = await edit({ ctaText: "Get a quote" }, SAID, {});
  assert.equal(stale.status, "ready", "no basedOn means the latest state is used");
  const old = await edit({ ctaText: "Call us today" }, SAID);
  assert.equal(old.status, "ready");
  const refused = await updateHostedSite({ store, scope, userMessage: SAID, input: { projectId: created.projectId, basedOn: first.updatedAt, ctaText: "Another" } });
  assert.equal(refused.code, "CONFLICT");
  assert.equal(JSON.parse(row().requirements_json).site.cta, "Call us today");
  // A concurrent writer lands between this edit's read and its write: the edit must not overwrite it.
  let interleaved = false;
  const racing = { ...store, update: async (...args) => {
    if (!interleaved) { interleaved = true; assert.equal(await store.update(scope, { id: created.projectId, expectedUpdatedAt: row().updated_at, name: "Team Hahn Construction", requirementsJson: row().requirements_json, evidenceJson: row().evidence_json, updatedAt: "2099-01-01T00:00:00.000Z" }), true); }
    return store.update(...args);
  } };
  const lost = await updateHostedSite({ store: racing, scope, userMessage: SAID, input: { projectId: created.projectId, tagline: "Framing and windows" } });
  assert.equal(lost.code, "CONFLICT");
  assert.equal(row().updated_at, "2099-01-01T00:00:00.000Z");
  assert.equal(JSON.parse(row().requirements_json).site.tagline, "Framing in Dakota County");
});

test("two edits in the same millisecond still get distinct, increasing timestamps", async () => {
  const { edit, row } = await seeded();
  const fixed = () => new Date("2020-01-01T00:00:00.000Z");
  const one = await edit({ tagline: "Framing in Dakota County" }, SAID, { now: fixed });
  const two = await edit({ ctaText: "Get a quote" }, SAID, { now: fixed });
  assert.ok(Date.parse(two.updatedAt) > Date.parse(one.updatedAt));
  assert.equal(row().updated_at, two.updatedAt);
});

test("an edit that fails verification is rejected and nothing is saved", async () => {
  const { sqlite, store, created, row } = await seeded();
  // A stored site that is already damaged cannot be silently re-saved as verified.
  const damaged = JSON.parse(row().requirements_json); damaged.site.pages.find((page) => page.id === "about").headline = "";
  sqlite.prepare("UPDATE genesis_projects SET requirements_json = ? WHERE id = ?").run(JSON.stringify(damaged), created.projectId);
  const before = row();
  const result = await updateHostedSite({ store, scope, userMessage: SAID, input: { projectId: created.projectId, tagline: "Framing in Dakota County" } });
  assert.equal(result.status, "failed");
  assert.match(result.code, /VERIFICATION_FAILED|INVALID_SITE/u);
  assert.deepEqual(row(), before);
});

test("services, name and pages: adding, removing and renaming keep the site consistent", async () => {
  const { store, created, edit } = await seeded();
  const named = await edit({ businessName: "Hahn Framing & Windows", addServices: [{ title: "Decks", description: "Deck framing." }], removeServices: ["Housewrap"] }, "Rename it to Hahn Framing & Windows, add Decks with Deck framing., remove Housewrap");
  assert.equal(named.status, "ready", named.message);
  assert.equal(named.name, "Hahn Framing & Windows");
  const row = await store.get(scope, created.projectId);
  const { site, spec } = JSON.parse(row.requirementsJson);
  assert.equal(site.name, "Hahn Framing & Windows"); assert.equal(spec.name, site.name); assert.equal(row.name, site.name);
  const services = site.pages.find((page) => page.id === "services").sections[0].items.map((item) => item.title);
  assert.ok(services.includes("Decks")); assert.equal(services.some((title) => /housewrap/iu.test(title)), false);
  assert.equal(site.pages.find((page) => page.id === "gallery").sections[0].items.includes("Decks"), true);
  assert.doesNotMatch(JSON.stringify(site), /Team Hahn/u);
  assert.doesNotMatch(site.pages[0].intro, /housewrap/iu);
  assert.match(site.pages[0].intro, /decks/iu);

  const removed = await edit({ removePages: ["gallery", "about"] }, "Remove the gallery and about pages");
  assert.equal(removed.status, "ready", removed.message);
  assert.equal(removed.pages.some((page) => /about|gallery/iu.test(page.path)), false);
  const added = await edit({ addPages: ["about"] }, "Add an about page");
  assert.equal(added.status, "ready", added.message);
  const order = JSON.parse((await store.get(scope, created.projectId)).requirementsJson).site.pages.map((page) => page.id);
  assert.ok(order.indexOf("services") < order.indexOf("about") && order.indexOf("about") < order.indexOf("contact"));
  assert.ok(added.remainingPlaceholders >= 2, "a new About page brings its placeholders back");
});

test("impossible edits are refused with a reason: unknown service, duplicates, last service, missing page", async () => {
  const { edit, row } = await seeded();
  const before = row();
  for (const [input, message] of [
    [{ removeServices: ["Plumbing"] }, "remove plumbing"], [{ addServices: [{ title: "Windows" }] }, "add windows"],
    [{ addPages: ["services"] }, "add services page"], [{ pageText: [{ slot: "details", page: "nope", text: "Some details here." }] }, "Some details here."],
    [{ removeServices: ["Wood framing", "Windows", "Doors", "Housewrap"] }, "remove wood framing, windows, doors, housewrap"],
  ]) {
    const result = await edit(input, message);
    assert.equal(result.status, "failed", JSON.stringify(input));
    assert.match(result.code, /CANNOT_APPLY|INVALID_PATCH/u);
  }
  assert.deepEqual(row(), before);
});

test("applyPatch is pure and says nothing changed when the site already says it", async () => {
  const { store, created } = await seeded();
  const stored = JSON.parse((await store.get(scope, created.projectId)).requirementsJson);
  const snapshot = structuredClone(stored);
  const same = applyPatch(stored.site, stored.spec, { ctaText: stored.site.cta });
  assert.equal(same.ok, false);
  const changed = applyPatch(stored.site, stored.spec, { ctaText: "Get a quote" });
  assert.equal(changed.ok, true);
  assert.deepEqual(stored, snapshot);
});

test("a missing table is reported as unavailable, not as success", async () => {
  const { sqlite, store } = await seeded();
  sqlite.exec("DROP TABLE genesis_projects");
  const result = await updateHostedSite({ store, scope, userMessage: SAID, input: { projectId: `gen_${uuid()}`, tagline: "Framing in Dakota County" } });
  assert.equal(result.status, "unavailable");
});
