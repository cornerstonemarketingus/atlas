import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ALLOWED_REPOSITORY = "cornerstonemarketingus/atlas";
const allowedModes = new Set(["inspect"]);
const outputDirectory = process.env.ATLAS_OUTPUT_DIR;

if (!outputDirectory) {
  throw new Error("ATLAS_OUTPUT_DIR is required");
}
fs.mkdirSync(outputDirectory, { recursive: true });

function reject(message) {
  const status = {
    schema_version: 1,
    status: "rejected",
    message,
    task_id: process.env.ATLAS_TASK_ID ?? "",
  };
  fs.writeFileSync(path.join(outputDirectory, "status.json"), `${JSON.stringify(status, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.error(`Atlas dispatch rejected: ${message}`);
  process.exit(1);
}

const taskId = process.env.ATLAS_TASK_ID ?? "";
const repository = process.env.ATLAS_REPOSITORY ?? "";
const branch = process.env.ATLAS_BRANCH ?? "";
const mode = process.env.ATLAS_MODE ?? "";
const objective = process.env.ATLAS_OBJECTIVE ?? "";

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) reject("invalid task_id");
if (repository !== ALLOWED_REPOSITORY) reject("repository is not allowlisted");
if (!allowedModes.has(mode)) reject("invalid mode");
if (!branch || branch.length > 255) reject("invalid branch name");
const branchCheck = spawnSync("git", ["check-ref-format", "--branch", branch], {
  encoding: "utf8",
  timeout: 5_000,
  windowsHide: true,
});
if (branchCheck.error || branchCheck.status !== 0) reject("invalid branch name");
if (!objective.trim() || Buffer.byteLength(objective, "utf8") > 4096) reject("objective must be 1-4096 UTF-8 bytes");

console.log(`Validated Atlas task ${taskId} for ${ALLOWED_REPOSITORY} (${mode}).`);
