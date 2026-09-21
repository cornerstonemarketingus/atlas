import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_UI_HTML, LOCAL_UI_JS } from "../src/ui.mjs";

test("Mission Control is accessible and wired to the authenticated mission API", () => {
  assert.match(LOCAL_UI_HTML, /<h2 id="missions-heading">Mission Control<\/h2>/u);
  assert.match(LOCAL_UI_HTML, /aria-live="polite"/u);
  assert.match(LOCAL_UI_HTML, /id="mission-lanes"/u);
  assert.match(LOCAL_UI_HTML, /id="mission-repository"/u);
  assert.match(LOCAL_UI_HTML, /id="mission-model"/u);
  assert.match(LOCAL_UI_HTML, /id="mission-refresh"/u);
  assert.doesNotThrow(() => new Function(LOCAL_UI_JS));

  for (const route of [
    "api('/v1/missions')",
    "api('/v1/missions/'+encodeURIComponent(id)+'/control'",
    "'/events?after='",
  ]) {
    assert.ok(LOCAL_UI_JS.includes(route), `Mission Control calls ${route}`);
  }

  for (const action of ["pause", "resume", "cancel"]) {
    assert.ok(LOCAL_UI_JS.includes(`data-mission-action="${action}"`));
  }

  assert.equal(/access_token=|token=|new EventSource/u.test(LOCAL_UI_JS), false);
  assert.ok(LOCAL_UI_JS.includes("esc(child.objective"), "child output is escaped before rendering");
  assert.ok(LOCAL_UI_JS.includes("repository,model,title,children,maxConcurrency"), "execution context is submitted");
  assert.ok(LOCAL_UI_JS.includes("!Array.isArray(child.dependencies)"), "dependencies are explicit");
  assert.ok(LOCAL_UI_JS.includes("state==='interrupted'"), "interrupted missions can be resumed");
  assert.ok(LOCAL_UI_JS.includes("Mission creation failed ('+response.status+')"), "HTTP errors remain visible");
});
