// Verifier for read-only questions. Usage: node answer-check.mjs <workspace> <check>
// The agent writes ANSWER.json; the truth is recomputed from the workspace's
// own files, so the agent's claim is compared with the repository, not trusted.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

const walk = (dir, accept) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  return entry.isDirectory() ? walk(full, accept) : accept(entry.name) ? [full] : [];
});
const rel = (root, file) => relative(root, file).split("\\").join("/");
const run = (command, args, options) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
};
const git = (root, ...args) => {
  const result = run("git", ["-C", root, ...args]);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
};
/** Secrets named inside `${{ ... }}` expressions, so prose in comments never counts. */
export const secretsIn = (text) => [...new Set([...text.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)]
  .flatMap((match) => [...match[1].matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/gu)].map((secret) => secret[1])))].sort();

/**
 * Read-only tasks: the only change the agent may leave behind is ANSWER.json.
 * Compared with the runner's "eval setup" commit when there is one, so a
 * change the agent committed still counts (like the runner's changedPaths).
 */
export function changedSources(root) {
  const setup = git(root, "log", "-1", "--format=%H", "--fixed-strings", "--grep=eval setup").trim() || "HEAD";
  const tracked = git(root, "diff", "--name-only", "--no-renames", "-z", setup, "--").split("\0");
  const untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0");
  return [...new Set([...tracked, ...untracked].filter((path) => path && path !== "ANSWER.json"))].sort();
}

export const CHECKS = {
  "merge-decision-usage": (root) => {
    const files = walk(join(root, "scripts"), (name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
    const importers = files.filter((file) => /import\s*\{[^}]*\bdecideMergeAction\b[^}]*\}\s*from/u.test(readFileSync(file, "utf8"))).map((file) => rel(root, file)).sort();
    const definedIn = files.filter((file) => /export function decideMergeAction\b/u.test(readFileSync(file, "utf8"))).map((file) => rel(root, file));
    return { definedIn: definedIn[0], importedBy: importers };
  },
  "coder-pr-env-vars": (root) => {
    const text = readFileSync(join(root, "scripts/runner/create-coder-pull-request.mjs"), "utf8");
    return { variables: [...new Set([...text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/gu)].map((match) => match[1]))].sort() };
  },
  "workflow-names": (root) => {
    const dir = join(root, ".github/workflows");
    const entries = readdirSync(dir).filter((name) => /\.ya?ml$/u.test(name)).sort().map((file) => {
      const match = /^name:\s*(.+?)\s*$/mu.exec(readFileSync(join(dir, file), "utf8"));
      return { file, name: match ? match[1].replace(/^["']|["']$/gu, "") : null };
    });
    return { workflows: entries };
  },
  "codeowners-paths": (root) => {
    const lines = readFileSync(join(root, ".github/CODEOWNERS"), "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    return { paths: [...new Set(lines.map((line) => line.split(/\s+/u)[0]))].sort() };
  },

  // tool-args: each truth comes from running the same tool, with the same
  // arguments, working directory and environment, that the agent must use.
  "report-result-history": (root) => {
    const lines = git(root, "log", "-5", "--format=%H%x09%s", "--", "scripts/runner/report-result.mjs").trim().split("\n");
    const entries = lines.map((line) => { const [hash, ...subject] = line.split("\t"); return { hash, subject: subject.join("\t") }; });
    return { latest: entries[0].hash, subjects: entries.map((entry) => entry.subject) };
  },
  "select-migrations-run": (root) => {
    const result = run(process.execPath, [join(root, "scripts/runner/select-migrations.mjs")], {
      cwd: join(root, "apps/web"),
      env: { PATH: process.env.PATH ?? "", FROM_MIGRATION: "0004", THROUGH_MIGRATION: "0009" },
    });
    if (result.status !== 0) throw new Error("select-migrations.mjs failed");
    return { output: result.stdout.trim() };
  },
  "inference-test-summary": (root) => {
    const result = run(process.execPath, ["--test", "tests/*.test.mjs"], { cwd: join(root, "packages/atlas-inference"), env: { PATH: process.env.PATH ?? "", CI: "1" } });
    const count = (name) => Number(new RegExp(`^# ${name} (\\d+)$`, "mu").exec(result.stdout)?.[1]);
    return { tests: count("tests"), pass: count("pass"), fail: count("fail") };
  },

  // final-synthesis: one answer assembled from many files.
  "package-inventory": (root) => {
    const dirs = [
      ...["apps", "packages"].flatMap((parent) => readdirSync(join(root, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => `${parent}/${entry.name}`)),
      "mobile",
    ].filter((dir) => existsSync(join(root, dir, "package.json"))).sort();
    return {
      packages: dirs.map((dir) => {
        const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
        const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
        return { dir, name: manifest.name, test: manifest.scripts?.test ?? null, dependencyFree: dependencies.length === 0 };
      }),
    };
  },
  "workflow-secrets": (root) => {
    const dir = join(root, ".github/workflows");
    const workflows = readdirSync(dir).filter((name) => /\.ya?ml$/u.test(name)).sort()
      .map((file) => ({ file, secrets: secretsIn(readFileSync(join(dir, file), "utf8")) }))
      .filter((workflow) => workflow.secrets.length > 0);
    const uses = new Map();
    for (const workflow of workflows) for (const secret of workflow.secrets) uses.set(secret, (uses.get(secret) ?? 0) + 1);
    return { workflows, shared: [...uses].filter(([, count]) => count >= 2).map(([secret]) => secret).sort() };
  },
  "runner-test-coverage": (root) => {
    const dir = join(root, "scripts/runner");
    const names = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const modules = names.filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs")).sort().map((name) => {
      const testName = name.replace(/\.mjs$/u, ".test.mjs");
      if (!names.includes(testName)) return { module: `scripts/runner/${name}`, test: null, tests: 0 };
      const tests = readFileSync(join(dir, testName), "utf8").split("\n").filter((line) => line.startsWith("test(")).length;
      return { module: `scripts/runner/${name}`, test: `scripts/runner/${testName}`, tests };
    });
    return { modules, untested: modules.filter((entry) => entry.test === null).map((entry) => entry.module) };
  },
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/").split("/").pop())) {
  const [root, check] = process.argv.slice(2);
  if (!root || !(check in CHECKS)) { console.error(`usage: answer-check.mjs <workspace> <${Object.keys(CHECKS).join("|")}>`); process.exit(2); }
  let answer;
  try { answer = JSON.parse(readFileSync(join(root, "ANSWER.json"), "utf8")); }
  catch { console.error("ANSWER.json is missing or is not valid JSON"); process.exit(1); }
  const changed = changedSources(root);
  if (changed.length > 0) { console.error(`a read-only task changed files other than ANSWER.json: ${changed.slice(0, 10).join(", ")}`); process.exit(1); }
  const truth = CHECKS[check](root);
  if (!isDeepStrictEqual(answer, truth)) { console.error(`ANSWER.json does not match the repository.\nexpected keys: ${Object.keys(truth).join(", ")}`); process.exit(1); }
  console.log("answer matches the repository");
}
