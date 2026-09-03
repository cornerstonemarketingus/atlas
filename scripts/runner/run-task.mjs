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

function writeStatus(status, message, extra = {}) {
  fs.writeFileSync(
    path.join(outputDirectory, "status.json"),
    `${JSON.stringify({ schema_version: 1, status, message, task_id: metadata.task_id, ...extra }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function runCommand(label, command, args, cwd, timeoutMs = 180_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_FILE_BYTES,
    windowsHide: true,
  });
  const stdout = (result.stdout ?? "").slice(0, MAX_FILE_BYTES);
  const stderr = (result.stderr ?? "").slice(0, MAX_FILE_BYTES);
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    label,
    exitCode: result.status,
    timedOut,
    ok: !result.error && result.status === 0,
    stdout,
    stderr,
  };
}

function writeJson(filename, value) {
  fs.writeFileSync(path.join(outputDirectory, filename), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Writes an artifact after scrubbing credentials out of it.
 *
 * Debug artifacts carry raw build and test output, and a failing test prints
 * whatever it compared. These files are uploaded to the workflow run, so an
 * unredacted one moves a credential out of a private repository and into an
 * artifact with a different audience.
 *
 * Redaction runs through `atlas redact` rather than a detector written here.
 * A second implementation in this file would drift from the one the agent
 * uses and give two different answers to "is this safe to publish"; delegating
 * means there is exactly one set of rules.
 *
 * Fails closed: if the CLI cannot redact, the artifact is NOT written. An
 * unredacted debug artifact is worse than a missing one, and the step's own
 * status already records what happened.
 */
function writeRedactedJson(filename, value) {
  const cli = path.resolve("packages/atlas-cli/dist/src/cli.js");
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const result = spawnSync(process.execPath, [cli, "redact", "--summary"], {
    input: serialized,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: MAX_FILE_BYTES,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    console.error(`Refusing to write ${filename}: redaction failed (${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}).`);
    return false;
  }
  // Placeholders are plain text, so redacted JSON stays parseable — but this is
  // an artifact other tools read, so it is verified rather than assumed.
  try {
    JSON.parse(result.stdout);
  } catch (error) {
    console.error(`Refusing to write ${filename}: redaction produced unparseable JSON (${error.message}).`);
    return false;
  }
  if (result.stderr) console.error(`${filename} redaction: ${result.stderr.trim()}`);
  fs.writeFileSync(path.join(outputDirectory, filename), result.stdout, { encoding: "utf8", mode: 0o600 });
  return true;
}

if (metadata.mode === "inspect") {
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
} else if (metadata.mode === "debug") {
  const packageDirectory = path.join(repositoryRoot, "packages", "atlas-cli");
  if (!fs.existsSync(path.join(packageDirectory, "package.json"))) {
    writeStatus("failed", "packages/atlas-cli/package.json was not found on the requested branch.");
    throw new Error("packages/atlas-cli is missing on the requested branch");
  }

  const steps = [
    ["install", "npm", ["ci", "--ignore-scripts"]],
    ["test", "npm", ["test"]], // runs the package's own build first, then its test suite
  ];

  const results = [];
  let failedAt = null;
  for (const [label, command, args] of steps) {
    const result = runCommand(label, command, args, packageDirectory);
    results.push(result);
    if (!result.ok) {
      failedAt = label;
      break;
    }
  }
  const debugWritten = writeRedactedJson("debug.json", { schema_version: 1, task_id: metadata.task_id, steps: results });

  if (failedAt) {
    writeStatus("failed", debugWritten
      ? `Debug run stopped at '${failedAt}'; see debug.json for captured output.`
      : `Debug run stopped at '${failedAt}'. debug.json was withheld because its output could not be redacted.`);
    console.error(`Atlas debug run failed at step '${failedAt}'.`);
    process.exit(1);
  }
  writeStatus("completed", "Build and test succeeded on the requested branch.");
  console.log("Atlas debug run completed: build and test passed.");
} else if (metadata.mode === "coder") {
  // The vendor is an operator choice, not a hardcoded one. ATLAS_CODER_PROVIDER
  // is validated here rather than passed through blindly so a typo fails with a
  // clear status instead of a CLI usage error buried in a log, and so this
  // never becomes a way to name an arbitrary environment variable to read.
  const providerInput = (process.env.ATLAS_CODER_PROVIDER || "").trim().toLowerCase();
  const PROVIDER_KEY_VARIABLES = { anthropic: "ANTHROPIC_API_KEY", groq: "GROQ_API_KEY" };
  if (providerInput && !Object.hasOwn(PROVIDER_KEY_VARIABLES, providerInput)) {
    const known = Object.keys(PROVIDER_KEY_VARIABLES).join(", ");
    writeStatus("failed", `ATLAS_CODER_PROVIDER '${providerInput}' is not recognised; expected one of: ${known}.`);
    console.error(`Atlas coder mode: unknown provider '${providerInput}'.`);
    process.exit(2);
  }
  const model = process.env.ATLAS_CODER_MODEL || "openai/gpt-oss-120b";
  // Match the CLI's own inference so the runner asks for the key the CLI will
  // actually look up; naming the provider explicitly below keeps the two from
  // drifting apart later.
  const provider = providerInput || (/^(anthropic\/)?claude[-.]/i.test(model) ? "anthropic" : "groq");
  const apiKeyVariable = PROVIDER_KEY_VARIABLES[provider];
  if (!process.env[apiKeyVariable]) {
    writeStatus("failed", `${apiKeyVariable} is not configured; coder tasks cannot run with provider '${provider}'.`);
    console.error(`Atlas coder mode requires ${apiKeyVariable}.`);
    process.exit(2);
  }
  const cli = path.resolve("packages/atlas-cli/dist/src/cli.js");
  // Verification runs the target repository's own build/test scripts, before
  // and after the edit, plus any repair passes — so this needs far more than
  // the flat 3 minutes a single model round trip needed.
  const coderTimeoutMs = Number(process.env.ATLAS_CODER_TIMEOUT_MS) || 900_000;
  const verifyDir = (process.env.ATLAS_VERIFY_DIR || "").trim();
  const repairAttempts = (process.env.ATLAS_MAX_REPAIR_ATTEMPTS || "").trim();
  const codeArgs = [
    cli, "code", repositoryRoot, metadata.objective,
    "--provider", provider,
    "--api-key-env", apiKeyVariable,
    "--model", model,
    "--format", "json",
  ];
  // A durable, redacted record of what the agent did, uploaded with the run's
  // other artifacts. Written by the CLI, so it goes through the same redactor
  // as everything else the agent emits.
  codeArgs.push("--audit-log", path.join(outputDirectory, "audit.jsonl"));
  if (verifyDir) codeArgs.push("--verify-dir", verifyDir);
  if (/^[0-5]$/.test(repairAttempts)) codeArgs.push("--max-repair-attempts", repairAttempts);
  const result = runCommand("code", process.execPath, codeArgs, process.cwd(), coderTimeoutMs);

  // 'atlas code' exits 1 for every non-'completed' agent outcome (failed,
  // blocked, cancelled, approval-required), not just crashes — those still
  // print a fully valid, informative JSON result to stdout (stderr is
  // empty). Parsing must happen before looking at the exit code at all, or
  // a real agent-level failure message gets silently dropped in favor of an
  // empty stderr string.
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // leave parsed null; handled below as a genuine crash
  }

  if (parsed === null) {
    writeJson("code.json", { schema_version: 1, task_id: metadata.task_id, status: "failed", edits: [], stderr: result.stderr.slice(0, 8192) });
    writeStatus("failed", `Coder run produced no parseable output: ${result.timedOut ? "timed out" : `exit code ${result.exitCode ?? "unknown"}`}.`);
    console.error(result.stderr || result.stdout.slice(0, 8192) || "(no output captured)");
    process.exit(1);
  }
  writeJson("code.json", parsed);

  if (parsed.status !== "completed") {
    writeStatus(parsed.status === "approval-required" ? "blocked" : parsed.status, parsed.message ?? `Coder agent stopped with status '${parsed.status}'.`);
    console.error(`Atlas coder run stopped with status '${parsed.status}': ${parsed.message ?? "(no message)"}`);
    process.exit(1);
  } else if (parsed.edits.length === 0) {
    writeStatus("completed", "Coder agent finished without proposing any file changes.");
    console.log("Atlas coder run completed with no file changes.");
  } else {
    const verification = parsed.verification ?? null;
    const verdict = verification ? ` Verification: ${verification.status} — ${verification.message}` : "";
    writeStatus(
      "completed",
      `Coder agent proposed ${parsed.edits.length} file change(s); opening a pull request next.${verdict}`,
      verification ? { verification } : {},
    );
    console.log(`Atlas coder run completed: ${parsed.edits.length} file(s) changed.`);
    if (verification) console.log(`Verification: ${verification.status} — ${verification.message}`);
  }
} else {
  writeStatus("unsupported", `Mode '${metadata.mode}' is not enabled; no repository mutation was attempted.`);
  console.error(`Atlas mode '${metadata.mode}' is intentionally unsupported in this read-only runner.`);
  process.exit(2);
}
