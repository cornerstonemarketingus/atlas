import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("build output includes the Atlas Genesis home page", () => {
  const serverBundle = readFileSync(new URL("../dist/server/index.js", import.meta.url), "utf8");
  assert.match(serverBundle, /Atlas Genesis/u);
});
