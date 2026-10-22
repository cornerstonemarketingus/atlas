import { randomUUID } from "node:crypto";
import { isOperationalTestObjective, runOperationalTests } from "./agent/operational-test-session.js";
import { planRepositoryTests } from "./infrastructure/repository-test-planner.js";
import { SafeValidationProfileRunner } from "./infrastructure/validation-profile-runner.js";
import { BoundedCommandRunner } from "./infrastructure/bounded-command-runner.js";
import { ContainerValidationProfileRunner } from "./infrastructure/container-validation-runner.js";
import { PatternSecretRedactor } from "./infrastructure/pattern-secret-redactor.js";
import { redactRenderedOutput } from "./presentation/redacted-output.js";
import { renderCodeJson, renderCodeText } from "./presentation/code-renderers.js";
import { ExecutionDeadline } from "./infrastructure/execution-deadline.js";
import { CoderProgressRecorder } from "./infrastructure/coder-progress-recorder.js";

/** Returns null for objectives requiring the normal model-driven coder. */
export async function executeOperationalTestCommand(args: readonly string[], format: "json" | "text"): Promise<number | null> {
  if (!isOperationalTestObjective(args[2] ?? "")) return null;
  if (args.includes("--no-verify") || args.includes("--dry-run")) throw new Error("A test execution objective cannot use --no-verify or --dry-run.");
  const option = (flag: string, fallback?: string) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    return value;
  };
  const integer = (flag: string, fallback: number, maximum: number) => {
    const value = Number(option(flag, String(fallback)));
    if (!Number.isSafeInteger(value) || value < 1000 || value > maximum) throw new Error(`${flag} is outside its allowed range.`);
    return value;
  };
  const root = args[1]!;
  const packageManager = option("--verify-package-manager", "npm")!;
  const plan = await planRepositoryTests(root, { packageManager, directory: option("--verify-dir", ".")! });
  const timeoutMs = integer("--verify-timeout-ms", 600_000, 1_800_000);
  const deadline = new ExecutionDeadline(integer("--execution-timeout-ms", 900_000, 2_700_000));
  const progressPath = option("--progress-file");
  const progress = new CoderProgressRecorder(progressPath === undefined ? {} : { filePath: progressPath });
  try {
    const sessionId = randomUUID();
    await progress.save({ schemaVersion: 1, sessionId, status: "running", phase: "tests", edits: [], plannedChecks: plan.profiles.map((profile) => profile.id) });
    const runtime = option("--verify-container");
    const runner = runtime !== undefined
      ? await ContainerValidationProfileRunner.create({ repositoryRoot: root, runtime, packageManager, timeoutMs, installDependencies: true })
      : new SafeValidationProfileRunner(new BoundedCommandRunner({
        repositoryRoot: root,
        allowedExecutables: [packageManager],
        inheritedEnvironmentVariables: ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "APPDATA", "ProgramFiles", "COMSPEC"],
        timeoutMs,
      }));
    const result = await runOperationalTests({ sessionId, plan, runner, signal: deadline.signal, onProgress: async (output) => {
      await progress.save({ ...output, schemaVersion: 1, status: "running", phase: "tests" });
    } });
    await progress.save({ schemaVersion: 1, ...result });
    console.log(await redactRenderedOutput(format === "json" ? renderCodeJson(result) : renderCodeText(result), new PatternSecretRedactor()));
    return result.status === "completed" ? 0 : 1;
  } finally {
    deadline.dispose();
  }
}
