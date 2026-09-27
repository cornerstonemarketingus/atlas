import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RepositoryConfigReferences } from "../src/infrastructure/repository-config-references.js";

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-env-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test("finds reads in code and declarations in examples, workflows and wrangler vars, with lines", async () => {
  const root = await repository({
    "src/server.ts": "const key = process.env.API_KEY;\nconst url = process.env[\"BASE_URL\"] ?? import.meta.env.VITE_PUBLIC;\nif (process.env.NODE_ENV === \"test\") {}\nconst token = process.env.GITHUB_TOKEN;\n",
    "src/deno.ts": "Deno.env.get(\"DENO_ONLY\");\n",
    "worker/app.py": "import os\nA = os.environ[\"PY_REQUIRED\"]\nB = os.environ.get('PY_OPTIONAL', 'x')\nC = os.getenv(\"BASE_URL\")\n",
    ".env.example": "# Settings\nAPI_KEY=\n# BASE_URL=https://example.test\nexport EXPORTED=1\n",
    ".github/workflows/deploy.yml": "on: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    env:\n      VITE_PUBLIC: ${{ vars.PUBLIC_URL }}\n    steps:\n      - run: echo\n        env:\n          PY_REQUIRED: ${{ secrets.PY_REQUIRED }}\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
    "wrangler.toml": "name = \"app\"\n[vars]\nDENO_ONLY = \"1\"\n[env.staging.vars]\nSTAGING_ONLY = \"2\"\n[build]\ncommand = \"x\"\n",
  });
  try {
    const result = await new RepositoryConfigReferences().find(root);
    const variable = (name: string) => result.variables.find((item) => item.name === name);
    const refs = (name: string) => variable(name)?.references.map((item) => `${item.kind} ${item.file}:${item.line} ${item.via}`);
    assert.deepEqual(refs("API_KEY"), ["declared .env.example:2 .env.example", "read src/server.ts:1 process.env"]);
    assert.deepEqual(refs("BASE_URL"), ["declared .env.example:3 .env.example", "read src/server.ts:2 process.env", "read worker/app.py:4 os.getenv"], "a commented-out example key still documents it");
    assert.deepEqual(refs("VITE_PUBLIC"), ["declared .github/workflows/deploy.yml:6 workflow env", "read src/server.ts:2 import.meta.env"]);
    assert.deepEqual(refs("PUBLIC_URL"), ["variable .github/workflows/deploy.yml:6 workflow vars"]);
    assert.deepEqual(refs("PY_REQUIRED"), ["declared .github/workflows/deploy.yml:10 workflow env", "secret .github/workflows/deploy.yml:10 workflow secrets", "read worker/app.py:2 os.environ"]);
    assert.deepEqual(refs("DENO_ONLY"), ["read src/deno.ts:1 Deno.env", "declared wrangler.toml:3 wrangler vars"]);
    assert.equal(variable("STAGING_ONLY")?.references[0]?.via, "wrangler vars");
    assert.equal(variable("EXPORTED")?.references[0]?.kind, "declared");
    assert.equal(variable("PY_OPTIONAL")?.undeclared, true);
    assert.equal(variable("API_KEY")?.undeclared, false);
    assert.equal(variable("NODE_ENV"), undefined, "ambient names are not configuration");
    assert.equal(variable("GITHUB_TOKEN"), undefined, "runner-provided names are not configuration");
    assert.equal(variable("Settings"), undefined, "comments are not keys");
    assert.deepEqual(result.declarationFiles, [".env.example", ".github/workflows/deploy.yml", "wrangler.toml"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never opens a real .env or .dev.vars file, and never records values", async () => {
  const root = await repository({
    ".env": "REAL_SECRET=sk-live-do-not-read\n",
    ".dev.vars": "LOCAL_SECRET=also-private\n",
    "apps/web/.env.local": "LOCAL_ONLY=private\n",
    "src/a.ts": "process.env.REAL_SECRET;\n",
  });
  try {
    const result = await new RepositoryConfigReferences().find(root);
    assert.deepEqual(result.variables.map((item) => item.name), ["REAL_SECRET"]);
    assert.deepEqual(result.variables[0]!.references.map((item) => item.file), ["src/a.ts"]);
    assert.equal(result.variables[0]!.undeclared, false, "with no declaration files at all, nothing is called undeclared");
    assert.ok(!JSON.stringify(result).includes("sk-live") && !JSON.stringify(result).includes("private"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
