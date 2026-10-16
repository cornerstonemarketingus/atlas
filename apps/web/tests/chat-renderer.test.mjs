import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
const require = createRequire(import.meta.url);
function renderer() {
  const source = readFileSync(new URL("../app/chat/MessageBody.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const context = vm.createContext({ exports: {}, require, React, renderToStaticMarkup });
  vm.runInContext(compiled, context);
  return text => {
    context.text = text;
    return vm.runInContext("renderToStaticMarkup(React.createElement(exports.MessageBody, { text }))", context, { timeout: 1000 });
  };
}
test("every streaming prefix of code fences and info strings renders without blocking", () => {
  const render = renderer();
  for (const sample of [
    '```typescript title="app.ts"\nconst value = 1;\n```',
    '```c++\nint main() {}\n```',
    '~~~shell session\necho ready\n~~~',
    '````js\n```\nvalue\n````',
    '```[unfinished', '```js extra info',
  ]) for (let length = 1; length <= sample.length; length++) {
    assert.equal(typeof render(sample.slice(0, length)), "string");
  }
});
test("unsupported fences preserve text, standard code renders, and untrusted text stays escaped", () => {
  const render = renderer();
  assert.match(render('```typescript title="app.ts"\nconst value = 1;\n```'), /const value = 1/);
  assert.match(render('```diff\n+added\n-removed\n```'), /diff-add/);
  const unsafe = render('<script>alert(1)</script>\n```<img src=x onerror=alert(1)>');
  assert.doesNotMatch(unsafe, /<script>|<img/u);
  assert.match(unsafe, /&lt;/);
});
