import { cp, mkdir, access } from "node:fs/promises";
import { dirname, join, resolve, parse, basename } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Shared by MSI and unpacked installs. Include the actual runtime graph and
 * precompiled coding runner, never a developer's node_modules or credentials.
 */
export async function stageLocalPayload(destination, source = sourceRoot) {
  const target = resolve(destination);
  if (target === parse(target).root || target === resolve(source)) throw new Error("Choose a separate Atlas installation directory.");
  const entries = ["apps/local-control/src", "apps/local-control/package.json", "apps/windows-companion",
    "scripts/local", "scripts/windows", "scripts/release", "packages/atlas-contracts/src", "packages/atlas-contracts/package.json",
    "packages/atlas-cli/dist/src", "packages/atlas-cli/package.json", "packages/atlas-inference/src", "packages/atlas-inference/package.json"];
  await access(join(source, "packages/atlas-cli/dist/src/cli.js"));
  for (const entry of entries) {
    const output = join(target, entry);
    await mkdir(dirname(output), { recursive: true });
    await cp(join(source, entry), output, { recursive: true, filter: (path) => !["node_modules", ".git", ".atlas"].includes(basename(path)) && !path.endsWith(".log") });
  }
  return { directory: target, entries };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--output");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--output <installation directory> is required.");
  await stageLocalPayload(process.argv[index + 1]);
  console.log("Atlas runtime, contracts and compiled coding runner staged.");
}
