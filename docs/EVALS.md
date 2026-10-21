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

### Running without a paid key

The CI run needs no purchased key:

| Target | How it authenticates |
|---|---|
| `groq:openai/gpt-4.1-mini:GITHUB_MODELS_TOKEN:https://models.github.ai/inference` | GitHub Models, through the OpenAI-compatible path, with the run's own `GITHUB_TOKEN` (the job declares `models: read`). Free-tier rate limits apply. |
| `workers-ai:@cf/openai/gpt-oss-120b:ATLAS_WORKERS_AI_TOKEN` | Cloudflare Workers AI, with the repository's existing `ATLAS_WORKERS_AI_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets (the same ones the coder workflow uses). |

Dispatching "Atlas eval" with a blank target runs both (Workers AI only when its secrets exist). A weekly schedule (Monday 06:17 UTC) does the same and uploads the report artifact. The adapter passes Workers AI the non-secret account id plus the one named key, and nothing else from the environment.

#### Free quotas: what the first runs showed (2026-10-19)

- **Workers AI** (run 39247409170): `actions-budget-guard` passed, then the
  account's free daily allowance ran out about 11 minutes in and every later
  task got HTTP 429. Before the quota ran out, two tasks hit the 2-minute agent
  deadline and four used up their 12 turns. That run is not a baseline score.
- **GitHub Models** (run 39247683371): the endpoint answered HTTP 200 with a
  4-byte `text/plain` body instead of a chat completion, before any tool call.
  The cause is still open. Diagnostics retain status, content type and byte
  count; response text stays private even when it is short.

So a free target cannot do all 35 tasks in one run. The harness handles this
without dropping tasks:

- A run refused with HTTP 429 is classed `quota`. It is left out of the pass
  rate, because it measures the provider, not the model. The target's
  remaining tasks are listed under "Not run" instead of being run into the
  same refusal.
- `--shard k/n` runs slice k of n, and `--shard day/n` picks the slice from
  the UTC date. A daily schedule with `day/7` covers every task once a week,
  each day's slice within the free allowance. Slices are dealt round-robin by
  task id. Adding or removing tasks can move other tasks between slices.

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

35 tasks, all validated by dry run (`35/35 fixtures valid`):

| Category | Tasks | Source |
|---|---|---|
| bug-localization | 10 | Atlas commits (runner, local-control agent, infrastructure, inference stream) |
| feature | 6 | Atlas commits (new modules from their tests) |
| multi-file-edit | 6 | Atlas commits touching 2–4 source files |
| test-repair | 3 | Atlas commits where behaviour changed and a test was updated |
| tool-args | 3 | Answer files whose truth comes from running git, a script with cwd/env, a test suite |
| final-synthesis | 3 | Answer files assembled from many files (packages, workflow secrets, runner test coverage) |
| navigation | 2 | Answer files |
| structured-output | 2 | Answer files |

25 of 35 come from real history. Review and browser reasoning still have no
tasks.

### Test-repair tasks

`setup` applies the commit's *new source* on top of its parent, so the stale
test fails; `solution` is the commit's repaired test. Passing the agent's own
test is not enough (deleting assertions would do that), so
`evals/verifiers/test-repair-check.mjs` checks that: the sources are
byte-identical to the commit (repair the test, not the code); the agent's test
passes; every test the stale file shared with the commit's repaired file is
still there; a hidden copy of the commit's repaired test passes; and, with
`--mutate`, the agent's test *fails* once the old source is put back, so it
really checks the new behaviour. Its own tests (in
`packages/atlas-eval/tests/verifiers.test.mjs`) prove deleted, weakened and
source-reverting "repairs" are rejected.

### Answer-file tasks

`evals/verifiers/answer-check.mjs` now also refuses an answer when the agent
changed any file other than `ANSWER.json`. Tool-args checks recompute the
truth by running the same tool the agent must run (`git log -- <path>`,
`select-migrations.mjs` from `apps/web` with `FROM_MIGRATION`/
`THROUGH_MIGRATION`, the `atlas-inference` test suite).

## Dogfood log

Every Atlas-on-Atlas task is recorded in `evals/dogfood/log.jsonl`: outcome
(`success`, `failed`, `abandoned`), failure class (a kebab-case slug, `null` on
success), model, tokens, and whether a person had to step in.

```bash
node packages/atlas-eval/src/cli.mjs dogfood add --task "PR #350 retry" \
  --outcome failed --failure-class empty-model-response --model llama-3.3-70b \
  --input-tokens 900 --output-tokens 40 --intervention yes --notes "short, no secrets"
node packages/atlas-eval/src/cli.mjs dogfood check                    # verifies the hash chain
node packages/atlas-eval/src/cli.mjs dogfood drafts --write-drafts evals/drafts   # classes seen 3+ times
```

Entries are validated, credential-shaped text is refused, and the log is
append-only (hash-chained). A recurring failure class becomes a draft task
skeleton with its evidence. A draft is deliberately not runnable: a person adds
the base commit, objective, verify command and solution and then runs
`validate`, so only proven tasks enter the suite.

## Status

| Item | State |
|---|---|
| Package, runner, reports, dry-run validation | Done (this PR) |
| First 10 tasks | Done; history-derived tasks cover 6 of 10 |
| Grow to 30–50 tasks | Done: 35 tasks, 25 from history, all pass `validate` (issue #128) |
| Test repair, tool arguments, final synthesis | Done: 3 tasks each, with `test-repair-check.mjs` and new answer checks |
| Categories still without tasks | review, browser reasoning |
| CI workflow (`atlas-eval.yml`): dry-run validation on PRs touching the harness, `workflow_dispatch` for full runs | Done in the workflow PR (#349, protected, owner review) |
| Dogfood log `evals/dogfood/` (2.2): validated append-only log, recurring-failure drafts | Done in the dogfood PR; the log starts empty (no fabricated history) |
| Groq Batch for background runs | Pending |
| Baseline pass rate | **Pending: no provider credential is available to this environment.** Dry-run validation results only |
