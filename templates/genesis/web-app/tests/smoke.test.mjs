import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("home page contains the Atlas Genesis heading", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Atlas Genesis/u);
});
