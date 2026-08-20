import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const outputDirectory = process.env.ATLAS_OUTPUT_DIR;
if (!outputDirectory) throw new Error("ATLAS_OUTPUT_DIR is required");
const repositoryRoot = process.env.ATLAS_REPOSITORY_ROOT ?? process.cwd();
fs.mkdirSync(outputDirectory, { recursive: true });

const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  timeout: 5_000,
  maxBuffer: 4096,
  windowsHide: true,
});
if (commitResult.error || commitResult.status !== 0) throw new Error("Unable to identify the inspected commit");

const metadata = {
  schema_version: 1,
  task_id: process.env.ATLAS_TASK_ID,
  repository: "cornerstonemarketingus/atlas",
  branch: process.env.ATLAS_BRANCH,
  mode: process.env.ATLAS_MODE,
  objective: process.env.ATLAS_OBJECTIVE,
  commit: commitResult.stdout.trim(),
  run_id: process.env.GITHUB_RUN_ID ?? null,
};
fs.writeFileSync(path.join(outputDirectory, "task.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

function writeStatus(status, message) {
  fs.writeFileSync(
    path.join(outputDirectory, "status.json"),
    `${JSON.stringify({ schema_version: 1, status, message, task_id: metadata.task_id }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

if (metadata.mode !== "inspect") {
  writeStatus("unsupported", `Mode '${metadata.mode}' is not enabled; no repository mutation was attempted.`);
  console.error(`Atlas mode '${metadata.mode}' is intentionally unsupported in this read-only runner.`);
  process.exit(2);
}

const cli = path.resolve("packages/atlas-cli/dist/src/cli.js");
const commands = [
  ["inspect", [cli, "inspect", repositoryRoot, "--format", "json"], "inspect.json"],
  ["tree", [cli, "tree", repositoryRoot, "--max-depth", "4", "--max-entries", "1000", "--format", "json"], "tree.json"],
];

for (const [label, args, filename] of commands) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: MAX_FILE_BYTES,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    writeStatus("failed", `${label} failed with exit code ${result.status ?? "unknown"}`);
    if (result.stderr) console.error(result.stderr.slice(0, 8192));
    throw result.error ?? new Error(`${label} failed with exit code ${result.status}`);
  }
  const output = result.stdout ?? "";
  if (Buffer.byteLength(output, "utf8") > MAX_FILE_BYTES) throw new Error(`${label} output exceeded artifact limit`);
  fs.writeFileSync(path.join(outputDirectory, filename), output, { encoding: "utf8", mode: 0o600 });
}

writeStatus("completed", "Read-only inspection completed successfully.");
console.log("Atlas read-only inspection completed.");
