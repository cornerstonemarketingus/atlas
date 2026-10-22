import { isAbsolute, join, relative, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { OperationalTestPlan } from "../agent/operational-test-session.js";
import { RepositoryPackageGraph } from "./repository-package-graph.js";

/** Uses the existing bounded, ignore-aware package graph; never interprets script bodies. */
export async function planRepositoryTests(root: string, options: { readonly packageManager?: string; readonly directory?: string } = {}): Promise<OperationalTestPlan> {
  const packageManager = options.packageManager ?? "npm";
  const directory = options.directory ?? ".";
  if (isAbsolute(directory) || directory.split(/[\\/]/u).includes("..")) throw new Error("Test directory must be a relative path inside the repository.");
  const canonicalRoot = await realpath(root);
  let scope = canonicalRoot;
  for (const part of directory.split(/[\\/]/u).filter((part) => part !== "." && part !== "")) {
    scope = join(scope, part);
    if ((await lstat(scope)).isSymbolicLink()) throw new Error("Test directory cannot contain a symlink.");
  }
  const canonicalScope = await realpath(scope);
  const scopePath = relative(canonicalRoot, canonicalScope);
  if (scopePath === ".." || scopePath.startsWith(`..${sep}`) || isAbsolute(scopePath)) throw new Error("Test directory escaped the repository.");
  const graph = await new RepositoryPackageGraph().build(canonicalScope);
  const packages = graph.packages.filter((item) => item.ecosystem === "npm" && item.scripts.includes("test"));
  // A root default test may orchestrate its own workspaces; run it once.
  const rootTest = packages.find((item) => item.directory === ".");
  const selected = rootTest === undefined ? packages : [rootTest];
  const profiles = selected.map((item) => {
    const cwd = join(directory, item.directory).replaceAll("\\", "/");
    return { id: `test:${cwd}:test`, kind: "test" as const, executable: packageManager, args: ["run", "test"], cwd };
  });
  if (profiles.length > 100) throw new Error("More than 100 package test suites were found; choose an explicit --verify-dir.");
  return {
    profiles,
    warnings: [...graph.warnings.map((item) => item.message), ...(profiles.length === 0 ? ["No declared package.json test script was found; tests were not executed."] : [])],
    limitations: ["Scope: declared package.json test scripts only; standalone, Python, browser prerequisites and platform-specific CI jobs are not inferred or provisioned."],
  };
}
