import type { ValidationCommandProfile, ValidationProfileRunner } from "../domain/validation-profile.js";
import type { ValidationSnapshot } from "../domain/validation-result.js";
import type { CodeOutput } from "../presentation/code-renderers.js";

/** Only a complete, read-only request qualifies. Mixed edit/fix requests keep the coder path. */
export function isOperationalTestObjective(objective: string): boolean {
  const text = objective.trim().replace(/\s+/gu, " ").replace(/[.!]$/u, "");
  return /^(?:please )?(?:run|execute) (?:the )?(?:(?:full|entire|complete) )?(?:test suite|test suites|tests)(?: for (?:the atlas repository|atlas|this repository|this repo|the repository|the repo))?(?: and (?:report|summarize|list|show) (?:any |the |all )?(?:failures|results|test failures|test results))?$/iu.test(text);
}

export interface OperationalTestPlan {
  readonly profiles: readonly ValidationCommandProfile[];
  readonly warnings: readonly string[];
  readonly limitations: readonly string[];
}

export interface OperationalTestOutput extends CodeOutput {
  readonly execution: {
    readonly kind: "tests";
    readonly scope: "declared-package-test-scripts";
    readonly outcome: "passed" | "failed" | "incomplete";
    readonly checks: ValidationSnapshot["observations"];
    readonly limitations: readonly string[];
  };
}

/** Executes once and reports actual observations. No model, writes, baseline reruns or repairs. */
export async function runOperationalTests(options: {
  readonly sessionId: string;
  readonly plan: OperationalTestPlan;
  readonly runner: ValidationProfileRunner;
  readonly signal?: AbortSignal;
  readonly onProgress?: (output: OperationalTestOutput) => Promise<void>;
}): Promise<OperationalTestOutput> {
  const observations: ValidationSnapshot["observations"][number][] = [];
  let plan = options.plan;
  if (options.plan.profiles.length > 0 && !options.signal?.aborted) {
    try {
      const snapshot = await options.runner.run({
        label: "baseline", profiles: options.plan.profiles, ...(options.signal ? { signal: options.signal } : {}),
        onObservation: async (observation) => {
          observations.push(observation);
          await options.onProgress?.(report(options.sessionId, options.plan, observations, false));
        },
      });
      // Runners that do not expose incremental observations still return the evidence.
      observations.splice(0, observations.length, ...snapshot.observations);
    } catch (error) {
      plan = { ...plan, warnings: [...plan.warnings, `Test execution stopped: ${error instanceof Error ? error.message : "unknown execution failure"}`] };
    }
  }
  return report(options.sessionId, plan, observations, true);
}

function report(sessionId: string, plan: OperationalTestPlan, observations: ValidationSnapshot["observations"], finished: boolean): OperationalTestOutput {
  const passed = observations.filter((item) => item.outcome === "passed").length;
  const failed = observations.filter((item) => item.outcome === "failed").length;
  const infrastructure = observations.filter((item) => item.outcome === "execution-failed" || item.outcome === "cancelled").length;
  const incomplete = !finished || plan.profiles.length === 0 || plan.warnings.length > 0 || observations.length !== plan.profiles.length || infrastructure > 0;
  const message = `Executed ${observations.length}/${plan.profiles.length} declared package test suite(s): ${passed} passed, ${failed} failed, ${infrastructure} could not complete.${incomplete ? " Test execution is incomplete." : ""}`;
  const failures = observations.filter((item) => item.outcome !== "passed").flatMap((item) => item.diagnostics.map((diagnostic) => `[${item.caseId}] ${diagnostic.message}`));
  return {
    sessionId,
    status: incomplete ? "failed" : "completed",
    summary: [message, ...failures.slice(0, 20), ...plan.warnings, ...plan.limitations].join("\n"),
    ...(incomplete ? { message } : {}),
    edits: [],
    verification: {
      status: incomplete ? "inconclusive" : failed > 0 ? "failed" : "verified",
      attempts: observations.length > 0 ? 1 : 0,
      checks: observations.map((item) => item.caseId),
      newFailures: failures,
      message,
      stopReason: null,
    },
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    execution: { kind: "tests", scope: "declared-package-test-scripts", outcome: incomplete ? "incomplete" : failed > 0 ? "failed" : "passed", checks: observations, limitations: plan.limitations },
  };
}
