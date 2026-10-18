# Codex handoff — the coder agent is intermittent (two distinct failure modes)

Verified against `main` @ `ec52bc5` on 2026-10-18. Supersedes the earlier
handoff, which described only failure mode A and would have left mode B in
place while reporting the coder as fixed.

## Read these first

`CLAUDE.md`, then `docs/PROGRAM.md` (governing), then `docs/PROGRESS.md`
(handoff log) — resume from the "Next" line of the latest entry.

## The situation

The Atlas coder agent is **intermittent, not cleanly regressed**. 1 of the
last 8 runs succeeded. Last success: Sep 23, run 25, which produced PR #54.
The two most recent runs failed for two *unrelated* reasons.

| Run | Objective | Died after | Verdict | Cause |
|---|---|---|---|---|
| 30 — `36321596752` (Sep 27) | trivial one-line doc change | 13s | failed | `Unknown tool input field: path` |
| 29 — `36245915257`, job `108414963899` (Sep 26) | validate token scopes in the deploy script | 5m 47s | blocked | `Tool-call limit reached.` |

None of the 25 currently open PRs addresses either one.

### Diagnostic constraint: the traces are gone

`.github/workflows/atlas-coder.yml:289` sets `retention-days: 7`. Both runs
are three weeks old, and `GET /repos/cornerstonemarketingus/atlas/actions/runs/{id}/artifacts`
returns `total_count: 0` for both. There is **no `audit.jsonl` to replay** for
either failure. For mode B you will need to produce fresh evidence (see below).

Consider raising `retention-days` for this workflow as part of the work — a
7-day window on the only diagnostic artifact an unattended agent produces is
why this handoff cannot hand you the trace.

---

## Failure mode A — a guessed field name kills the whole run

**Error:** `Unknown tool input field: path`. Run `36321596752`, dead in 13
seconds on a one-line documentation change.

### Root cause — three facts, each re-verified today

1. `packages/atlas-cli/src/infrastructure/policy-enforced-read-only-tool-registry.ts:78`
   calls `definition.validateInput(request.input)` **outside** the `try` that
   opens on line 81. That `catch` is what converts a tool's own execution
   failure into `{ status: "failed", policy, message }` — an ordinary domain
   result the model sees and adapts to. Input-validation failures bypass it
   entirely and propagate up as thrown errors.

2. `repository-read-only-tools.ts:282` and `repository-write-tools.ts:355`
   both throw ``new RepositoryToolInputError(`Unknown tool input field: ${unknownKey}`)``
   — with **no tool name and no list of valid fields**. And
   `RepositoryToolInputError extends Error` (`repository-read-only-tools.ts:33`),
   *not* `ReadOnlyToolRegistryError`.

3. `packages/atlas-cli/src/agent/provider-read-only-tool-agent.ts:159`
   rethrows anything that is not a `ReadOnlyToolRegistryError` with code
   `TOOL_NOT_FOUND`. A `RepositoryToolInputError` therefore ends the session.

Net effect: the model guesses one field name, and an unattended run dies in 13
seconds with a message that does not even say which tool was being called.

### The precedent to mirror

PR #23 made `TOOL_NOT_FOUND` recoverable: the model gets a tool-role error
message listing the available tool names and corrects itself on the next turn.
The comment at `provider-read-only-tool-agent.ts:150-159` explains exactly why
that case is recoverable and the security cases are not. Do the same thing for
input validation.

### Must

- A validation failure becomes a **recoverable tool result**, delivered to the
  model as a tool message so it can retry — not a thrown error.
- The message **names the tool and lists its valid field names**. `Unknown
  tool input field: path` with no tool name is unusable by the model *and* by a
  human reading the log.
- A recovered validation failure **consumes a tool call** against
  `maximumToolCalls`. Otherwise a model that loops on a bad field name spins
  forever — which is mode B.

### Must not

- Do **not** make `POLICY_DENIED` or `SCOPE_MISMATCH` recoverable. Those are
  security decisions, and "try again with something else" is precisely the
  wrong thing to invite after one.
- Do **not** widen any tool schema to accept `path` (or any other field the
  model guessed). The schema is right; the error reporting is wrong.
- Do **not** loosen or remove the unknown-field rejection. Validation stays
  exactly as strict as it is now.

---

## Failure mode B — the tool-call budget is exhausted and nothing is produced

**Error:** `Tool-call limit reached.` Verdict `blocked`. Run `36245915257`,
job `108414963899`, 2026-09-26 13:39:55Z → 13:45:42Z.

**Objective:** "Add a check in the web app's deployment script to validate the
ATLAS_GITHUB_TOKEN secret scopes…"

### Mechanics

- `provider-read-only-tool-agent.ts:130-133` — each tool call increments
  `toolCalls`; exceeding `#maximumToolCalls` returns
  `this.block(sessionId, "Tool-call limit reached.", trace())`.
- `cli.ts:489-491` — `coderToolCallLimit(maximumTurns) = Math.min(128, Math.max(16, maximumTurns * 3))`.
- `scripts/runner/run-task.mjs:257` — `ATLAS_MAX_TURNS` defaults to 32.

So the ceiling was **96 tool calls**, not 32. Run 29 spent all 96 in under six
minutes and produced nothing at all.

### Answer this before changing anything

**Did it do 96 distinct useful things, or did it loop?** 96 calls in under six
minutes, on a task needing maybe ten reads, points hard at repetition —
re-reading the same file, or re-issuing the same search. Raising the number
without knowing which is just a more expensive failure.

Because both artifacts have expired, get fresh evidence: dispatch a coder run
on a comparable medium-sized objective, then replay its trace —

    atlas replay atlas-output/audit.jsonl

(`packages/atlas-cli/src/cli-replay.ts`; renders turns, tool calls and policy
decisions in order, and marks calls that never returned as `NO RESULT`.)
Identical repeated `toolId` + arguments is the signature of a loop.

### Fix by cause, in this order of preference

1. **If it looped** — give the agent what it needs in order not to. Candidates:
   a deduplicating tool result ("you already read this file in turn 4"), or
   putting the count of calls already spent into the turn context so the model
   can budget. This is the real fix.
2. **If it genuinely needed more than 96 calls** — the objective was too large
   for one session, and the answer is decomposition (a planner/implementer
   split), not a bigger number.
3. **Raising `ATLAS_MAX_TURNS` is not a fix** and must not be the whole change.
   `CLAUDE.md`: "Never reduce what Atlas can do to fit a provider limit;
   schedule or route instead." The inverse holds too — do not paper over a
   loop with a bigger budget.

### Worth doing either way

A `blocked` verdict writes no PR, so a run that spent 96 tool calls and six
minutes returns the operator nothing. Consider having the exhaustion path spend
one extra turn asking the model for a final summary of what it found, so the
run yields partial value instead of zero. Flag this before implementing it —
it changes a verdict path.

---

## Repo rules that apply (from `CLAUDE.md`)

- `docs/PROGRAM.md` is governing. Phases run in order; each has an exit gate.
  Do not start a phase whose predecessor's gate has not passed.
- Protected paths (`.github/CODEOWNERS`) need owner review. Open the PR
  normally. **Never** edit rulesets or CODEOWNERS to unblock yourself.
- Run `python3 .github/atlas/check-workflows.py` before **every** workflow
  push. A malformed workflow produces zero jobs and no error message.
- Truth order: code + tests + live verification > `docs/PROGRESS.md` >
  `TODO.md`. `TODO.md` is a stale wishlist.
- **No secrets in prompts, logs, commits or PR text.**

Checks as CI runs them:

- `packages/atlas-cli` — `npm ci --ignore-scripts && npm run build && npm test`
- `scripts/runner` — `node --test scripts/runner/*.test.mjs scripts/local/*.test.mjs`

## Verification bar — both fixes, in this order

1. Write the test **first**. Run it against current `main` and confirm it
   **fails**.
2. Apply the fix. Confirm the test passes and the whole package suite passes.
3. Revert the fix only, keeping the test, and confirm it **fails again**. A
   guard test that still passes with the guard removed is not a test.
4. Mode A touches an existing test that pinned the old fatal behaviour for
   unregistered tool names. Preserve its real intent — *a dangerous
   unregistered name never executes* — by asserting that directly, rather than
   inferring it from the session dying.
5. If any new behaviour is reachable only through the CLI, add a wiring test
   driven through `main()`. Three features in this repository have shipped
   complete, correct and unreachable because nothing wired them in `cli.ts`.
6. Update `docs/PROGRESS.md` with a new entry ending in a "Next" line.

## Open items that bear on this work

- **PR #157** (open, CI green) rewrites `scripts/runner/actions-budget.mjs`
  from fail-open to fail-closed, adding `ATLAS_ACTIONS_UNKNOWN_POLICY`
  (`block` | `allow`) and a `budget.json`. It fixes a genuine flaw — the
  current version echoes the raw billing API body into the log. **But** once
  merged, self-hosted runs block entirely unless the dispatch token gains
  billing read access or `ATLAS_ACTIONS_UNKNOWN_POLICY=allow` is set as a repo
  variable. Set that variable before or alongside the merge, or every coder run
  stops at the budget gate.
- **PRs #52 and #54** are the output of *successful* coder runs, open and
  unreviewed since Sep 23. They are the best available evidence of what the
  agent produces when it works.

## Done looks like

- A coder run on a trivial objective completes instead of dying on a guessed
  field name.
- A coder run on a medium objective either completes, or returns a verdict that
  says what it found — and its replayed trace shows no repeated identical tool
  calls.
- `docs/PROGRESS.md` records both, with a "Next" line.
