# Atlas eval harness

`packages/atlas-eval` measures **verified task completion**: a task passes only
when its own verification command exits 0 in a fresh checkout after the agent
ran. Nothing the agent says is counted. This is PROGRAM.md Phase 2.1; the
dogfood log (2.2) and CI wiring are separate PRs (see Status).

## Run it

```bash
# No model needed. Proves every task fails untouched and passes with its
# recorded solution. This is what CI should run on every PR.
node packages/atlas-eval/src/cli.mjs validate [--only <task-id>]

# Full run against one or more targets (needs packages/atlas-cli built:
# cd packages/atlas-cli && npm ci --ignore-scripts && npm run build).
GROQ_API_KEY=... node packages/atlas-eval/src/cli.mjs run \
  --target groq:llama-3.3-70b-versatile:GROQ_API_KEY --out eval-report
```

A target is `provider:model:API_KEY_ENV[:base-url]`. Only the *name* of the key
variable is accepted; the key is read from the environment and passed to the
coder process alone. Verification runs with an allowlisted environment (no keys).
`--out` writes `<prefix>.json` and `<prefix>.md`.

The git history must be available (`git fetch --unshallow`; in CI use
`fetch-depth: 0`), because workspaces are detached worktrees of each task's
`baseCommit`.

## How a task works

Files in `evals/tasks/<id>.json`, validated by `validateTask`:

| Field | Meaning |
|---|---|
| `baseCommit` | Checked out into a temporary worktree (always removed afterwards) |
| `objective` | What the agent is told. It must name the interfaces the tests need |
| `setup` | Applied before the agent runs: `fromCommit`+`paths` (e.g. the new tests) and/or literal `files` |
| `verify.argv` | The check, as an argv array (never a shell string). `{workspace}` and `{repo}` are substituted |
| `solution` | Files that make it pass (`fromCommit`+`paths` and/or `files`). Used only by dry runs |
| `category`, `tags`, `timeoutMs` | Reporting and deadlines |

Results (`EvalResult`) carry `passed`, `verified`, tool calls/errors, repairs,
latency, time to first model response, tokens, `failureClass`
(`tests_failed`, `agent_error`, `timeout`, `no_change`, `infra`) and evidence.
A run that passes without changing any file is `no_change`, not a pass; a
missing verify command or a git failure is `infra`, never a model failure.

### Add a task from history

1. Pick a commit that adds or changes tests for dependency-free code
   (`node --test` on files that import nothing installed).
2. `baseCommit` = its parent. `setup` = the test files from the commit.
   `solution.paths` = the non-test files the commit changed.
3. Write an objective a person could implement from; run
   `atlas-eval validate --only <id>`. It must say the task fails untouched and
   passes with the solution.

Read-only questions (navigation, structured output) write `ANSWER.json`, and
`evals/verifiers/answer-check.mjs` recomputes the truth from the workspace's own
files. Add a check there, then a task that names it.

## The first tasks

Ten tasks, all validated by dry run: six from Atlas's own commits
(multi-file edit ×2, bug localisation ×2, feature ×2) and four repository
questions (navigation ×2, structured output ×2).

## Status

| Item | State |
|---|---|
| Package, runner, reports, dry-run validation | Done (this PR) |
| First 10 tasks | Done; history-derived tasks cover 6 of 10 |
| Categories still without tasks | test repair, tool arguments, review, final synthesis, browser reasoning |
| Grow to 30–50 tasks | Pending |
| CI workflow (`atlas-eval.yml`): dry-run validation on PRs touching the harness, `workflow_dispatch` for full runs | Done in the follow-up workflow PR (protected, owner review) |
| Dogfood log `evals/dogfood/` (2.2) | Pending |
| Groq Batch for background runs | Pending |
| Baseline pass rate | **Pending: no provider credential is available to this environment.** Dry-run validation results only |
