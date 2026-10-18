import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SafeCommandRequest, SafeCommandResult, SafeCommandRunner } from "../src/domain/safe-command-runner.js";
import { InvalidValidationProfileError } from "../src/domain/validation-profile.js";
import { SafeValidationProfileRunner } from "../src/infrastructure/validation-profile-runner.js";

const result = (overrides: Partial<SafeCommandResult> = {}): SafeCommandResult => ({
  exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false, truncated: false, durationMs: 12, ...overrides,
});

class MockRunner implements SafeCommandRunner {
  public readonly requests: SafeCommandRequest[] = [];
  public constructor(private readonly values: readonly (SafeCommandResult | Error)[]) {}
  public async run(request: SafeCommandRequest): Promise<SafeCommandResult> {
    this.requests.push(request);
    const value = this.values[this.requests.length - 1] ?? result();
    if (value instanceof Error) throw value;
    return value;
  }
}

const profile = (overrides: Partial<{ id: string; kind: "test"; executable: string; args: readonly string[]; attempts: number }> = {}) => ({
  id: "unit", kind: "test" as const, executable: "npm", args: ["test"], ...overrides,
});

describe("SafeValidationProfileRunner", () => {
  it("converts explicit command outcomes without recording raw arguments", async () => {
    const mock = new MockRunner([result({ exitCode: 2, stderr: "token=top-secret\nfailed assertion" })]);
    const snapshot = await new SafeValidationProfileRunner(mock).run({ label: "baseline", profiles: [profile({ args: ["test", "--secret=top-secret"] })] });
    assert.equal(snapshot.observations[0]?.outcome, "failed");
    assert.equal(snapshot.observations[0]?.command.argumentCount, 2);
    assert.equal(JSON.stringify(snapshot), JSON.stringify(snapshot).replaceAll("top-secret", ""));
    assert.match(snapshot.observations[0]?.diagnostics[1]?.message ?? "", /token=\[REDACTED\]/u);
  });

  it("marks runner exceptions, cancellation, and timeouts as infrastructure outcomes", async () => {
    const mock = new MockRunner([new Error("spawn"), result({ cancelled: true, exitCode: null }), result({ timedOut: true, exitCode: null })]);
    const snapshot = await new SafeValidationProfileRunner(mock).run({ label: "post-change", profiles: [profile({ id: "a" }), profile({ id: "b" }), profile({ id: "c" })] });
    assert.deepEqual(snapshot.observations.map((item) => item.outcome), ["execution-failed", "cancelled", "execution-failed"]);
  });

  it("judges a run with long output by its exit code", async () => {
    const mock = new MockRunner([result({ truncated: true, exitCode: 0 }), result({ truncated: true, exitCode: 1, stdout: "many lines\n[... 5 bytes of output omitted ...]\n1 failing" })]);
    const snapshot = await new SafeValidationProfileRunner(mock).run({ label: "post-change", profiles: [profile({ id: "a" }), profile({ id: "b" })] });
    assert.deepEqual(snapshot.observations.map((item) => item.outcome), ["passed", "failed"]);
    assert.deepEqual(snapshot.observations[0]?.diagnostics, [], "a passing run gains no diagnostic the comparator would count as new");
  });

  it("runs explicit repeated attempts for flaky comparison", async () => {
    const mock = new MockRunner([result({ exitCode: 1, stderr: "intermittent" }), result()]);
    const snapshot = await new SafeValidationProfileRunner(mock).run({ label: "baseline", profiles: [profile({ attempts: 2 })] });
    assert.deepEqual(snapshot.observations.map((item) => item.attempt), [1, 2]);
    assert.equal(mock.requests.length, 2);
  });

  it("bounds sanitized output", async () => {
    const mock = new MockRunner([result({ exitCode: 1, stdout: "x".repeat(20) })]);
    const snapshot = await new SafeValidationProfileRunner(mock, { maxOutputCharacters: 10 }).run({ label: "baseline", profiles: [profile()] });
    assert.equal(snapshot.observations[0]?.diagnostics[1]?.message, "…xxxxxxxxxx");
  });

  it("keeps the end of long failure output, where the summary is", async () => {
    const mock = new MockRunner([result({ exitCode: 1, stdout: `${"noise ".repeat(50)}1 failing: expected 2` })]);
    const snapshot = await new SafeValidationProfileRunner(mock, { maxOutputCharacters: 30 }).run({ label: "baseline", profiles: [profile()] });
    assert.match(snapshot.observations[0]?.diagnostics[1]?.message ?? "", /1 failing: expected 2$/);
  });

  it("rejects invalid or implicit profiles before the runner is called", async () => {
    const mock = new MockRunner([]);
    const runner = new SafeValidationProfileRunner(mock);
    await assert.rejects(() => runner.run({ label: "baseline", profiles: [] }), InvalidValidationProfileError);
    await assert.rejects(() => runner.run({ label: "baseline", profiles: [profile({ id: "", attempts: 0 })] }), InvalidValidationProfileError);
    assert.equal(mock.requests.length, 0);
  });
});
