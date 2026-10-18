// Verifier for read-only questions. Usage: node answer-check.mjs <workspace> <check>
// The agent writes ANSWER.json; the truth is recomputed from the workspace's
// own files, so the agent's claim is compared with the repository, not trusted.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

const walk = (dir, accept) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  return entry.isDirectory() ? walk(full, accept) : accept(entry.name) ? [full] : [];
});
const rel = (root, file) => relative(root, file).split("\\").join("/");

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
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/").split("/").pop())) {
  const [root, check] = process.argv.slice(2);
  if (!root || !(check in CHECKS)) { console.error(`usage: answer-check.mjs <workspace> <${Object.keys(CHECKS).join("|")}>`); process.exit(2); }
  let answer;
  try { answer = JSON.parse(readFileSync(join(root, "ANSWER.json"), "utf8")); }
  catch { console.error("ANSWER.json is missing or is not valid JSON"); process.exit(1); }
  const truth = CHECKS[check](root);
  if (!isDeepStrictEqual(answer, truth)) { console.error(`ANSWER.json does not match the repository.\nexpected keys: ${Object.keys(truth).join(", ")}`); process.exit(1); }
  console.log("answer matches the repository");
}
