# Project Genesis: idea → working local application

Genesis takes one sentence ("Build me a simple CRM for my construction
company") and produces a working application on the owner's machine. It
tests the application, runs it, inspects it in a browser, repairs what fails,
and presents it. Publishing happens afterwards, and only with approval.

Genesis orchestrates infrastructure Atlas already has. It is not a second
coder, worktree system, approval system or agent framework.

## Audit of main (27 Sep 2026)

### Genesis pieces that already existed

| Piece | Where | State |
| --- | --- | --- |
| Hosted intake: `genesis_projects` table and `POST/GET /api/genesis/projects` | `apps/web` (#107) | Stores the prompt and a stub requirements object with `status: "planned"`. Nothing executes it. |
| Roadmap entries | `TODO.md` ("Project Genesis … #73"), `docs/atlas-os/CURRENT-STATE.md` ("MISSING"), `PARALLEL-WORKSTREAMS.md` (workstream D) | Described but not built. |

### Execution primitives Genesis reuses

| Need | Existing primitive |
| --- | --- |
| Make and repair code in a workspace | `packages/atlas-cli` `atlas code <repo> <objective>`. It detects build/test/lint/typecheck scripts, verifies its own edit and repairs it (`--max-repair-attempts`). The daemon already drives it through `platform/self-improve/runtime.mjs` (`createCoderBuilder`). |
| Run checks without a shell, Windows included | `runtime.mjs` `runCheck` / `resolveCheck`, and `agent/tools/process.mjs` `runCommand` / `safeEnvironment` |
| Git in a workspace | `platform/engineering/git.mjs` (`git`, `commitConfig`, `diffStats`) |
| Isolated attempts | `platform/engineering/worktrees.mjs` `WorktreeManager`, with `atlas/` branches |
| Durable tasks, events and artifacts | `platform/task-store.mjs` `PlatformTaskStore` (outbox, events, artifacts) |
| Approvals and policies | `store.mjs` `local_policies` and `createApproval`, and `server.mjs` approval decisions |
| Browser | `agent/browser/playwright-page.mjs` (optional `playwright-core`, SSRF guard with `allowPrivateHosts`) and `apps/browser-worker` (disposable, origin-confined sessions with a `verify` export) |
| Publishing | `publish-adapters.mjs` (GitHub/GitLab/Forgejo) and `agent/infrastructure/{cloudflare,vercel,git-hosts}.mjs` (plan/apply/rollback) |
| Model choice | `agent/models/*` (catalog, difficulty, hosting). This is **Intelligence Layer territory**; Genesis only calls it through an adapter. |

### Parts of the spec that already exist under other names

- "Bounded tasks with dependencies": `agent/team/planner.mjs` (`validatePlan`, 8 steps with `dependsOn`) and `platform/orchestrator/dag.mjs`. Both are for agent missions. Genesis tasks need template/coder/checks/browser executors and per-task evidence, so they are kept in Genesis's own small table and reuse the dependency-ordering idea.
- "Repair loop": the coder's own verify→repair loop, plus the self-improvement loop's baseline/re-check/policy/review flow.
- "Recovery after restart": `store.mjs` marks running local tasks `interrupted`, and missions are interrupted the same way. Genesis follows that pattern: a project caught mid-work is paused, with the reason recorded.

### What was missing for PROMPT → WORKING LOCAL APPLICATION

1. A lifecycle and durable project state with evidence (**PR 1, this PR**).
2. A local project workspace (no GitHub), initialised with git, from a curated, versioned template with known install/dev/test/build/preview commands.
3. A task executor: template tasks run deterministically, coder tasks run through `createCoderBuilder` in the workspace, one bounded objective at a time.
4. A verify → repair loop with a budget (evidence in, bounded coder repair, re-verify).
5. A preview manager: port allocation, process tracking, health check, logs, stop/restart, orphan cleanup.
6. Browser verification of the running preview (DOM and console evidence first, screenshots when a vision model exists).
7. A bounded UI polish pass.
8. Live Genesis UX in the local app and chat (plain progress, expandable details).
9. **Publishing handoff.** Done: `publish.mjs`.
   - A ready project is pushed to a repository the owner already created, on
     any git host, using the owner's own git sign-in. Atlas stores no host
     token and never prompts.
   - The existing `publish.remote` policy decides: `deny` refuses, `ask` (the
     default) files an approval in the normal Approvals list and on paired
     phones, and `allow` proceeds.
   - The approval is bound to the project, the destination and the exact
     commit. A project changed after the request makes the approval stale,
     and nothing is pushed.
   - Pending requests survive restarts. The lifecycle goes ready →
     publishing → published, or back to ready with the reason.
   - This is available from the Build page and through the `genesis.publish`
     chat tool.
   - **Creating a repository**: `git-hosts.mjs` `createRepositoryCreator` for
     GitHub, GitLab and Forgejo. It plans the repository and refuses a name
     that is taken. After approval under `publish.remote` it creates the
     repository, reads it back and pushes the project.
   - **Deploying**: `vercel.mjs` `planStaticDeployment` /
     `applyStaticDeployment` for the website template's built `dist/`.
     - The plan's digest covers every file's hash, so a rebuilt site needs a
       new approval, under the new `deploy.remote` policy (default `ask`).
     - The deployment counts as done only when Vercel reports it `READY`.
     - Web apps and APIs, which need a running server and database, are
       refused for static hosting, with the alternatives stated.
   - **Tokens**: `ATLAS_GITHUB_TOKEN`, `ATLAS_GITLAB_TOKEN`,
     `ATLAS_FORGEJO_TOKEN` and `ATLAS_VERCEL_TOKEN` come from the credential
     vault, then the environment. They never appear in plans, approvals or
     evidence.
   - **Why not Cloudflare Pages**: its direct upload needs BLAKE3 file hashes,
     which Node cannot compute without a native dependency. Cloudflare DNS
     (already in the adapter) can point a domain at the deployment.
10. Repeatable end-to-end scenarios with recorded metrics.

## Collision boundaries with the Intelligence Layer

Genesis does **not** modify `agent/models/*`, `platform/models/*`, `platform/planning/*`, or any context-retrieval or failure-analysis code. It calls reasoning only through `platform/genesis/intelligence.mjs`:

- `refineSpecification({ prompt, draft })` returns a spec with the same shape;
- `refinePlan({ spec, draft })` returns a plan with the same shape;
- `modelFor({ task, attempt })` returns `{ model }` or `null` (the coder's default);
- `explainFailure({ task, evidence })` returns `{ summary, hints[] }`.

The defaults are deterministic, and any method can be replaced. Refinements that break the shape are discarded, so a weak model can fail to help but can never corrupt project state.

## Lifecycle

```
idea → requirements → planned → approved → scaffolding → building → verifying
     → previewing → reviewing → ready → publishing → published
repairing: loops back from verifying, previewing and reviewing
paused / blocked (remember where to resume) · failed · cancelled (final)
ready / published → requirements: conversational changes ("Add Google login")
```

`platform/genesis/lifecycle.mjs` is the only authority on legal moves.
Building cannot jump to ready, and verification cannot be skipped. Every
transition is written to `genesis_transitions` in the same transaction as the
state change, with a reason, evidence and actor.

## Requirements and plans

- `requirements.mjs` infers a structured spec from the prompt: name,
  objective, archetype, target users, pages, workflows, entities with typed
  fields, auth, integrations, design, deployment, constraints, acceptance
  criteria, assumptions and questions. The inference is deterministic, and
  every default is listed as an assumption.
- Questions are asked only for payments (cost and credentials), regulated
  health data, and automatic messages to real people.
- `planner.mjs` produces at most 16 bounded tasks. Each has an objective,
  inputs, outputs, dependencies, verification and an executor
  (`template` / `coder` / `checks` / `browser`). No task is "build the whole
  app".
- Plan approval follows the `genesis.plan` policy, which defaults to `allow`
  because building locally only writes inside the project folder. Set it to
  `ask` to approve each plan yourself.

## Templates (`platform/genesis/templates/`)

| Template | For | What the configuration drives |
| --- | --- | --- |
| `web-app` 1.0.0 | web apps, dashboards, internal tools | Record types, typed fields and validation, search, status, dashboard counts, optional public booking form (`app.config.json`) |
| `static-site` 1.0.0 | business and marketing sites | Pages, trade-appropriate copy, SEO basics, sitemap, working enquiry form (`site.json`) |
| `api-service` 1.0.0 | REST APIs | CRUD, search and stats endpoints per record type (`app.config.json`) |

All three use only Node's standard library (`node:http`, `node:sqlite`,
`node:test`). A generated project has nothing to install, works offline and
runs wherever Atlas runs. Each template declares its `check`, `test` and
`build` commands, its preview command, environment and health URL, and its
structure. Servers send a strict CSP (no inline scripts), `nosniff`,
`no-referrer` and `DENY` framing headers. They cap request bodies at 64 KiB,
bind to 127.0.0.1, and render stored text with `textContent` or escaping.
The generated tests exercise every record type in the configuration, so the
features a spec asks for are verified behaviour, not stubs.

`workspace.mjs` creates `~/.atlas/genesis/projects/<name>-<id>`. It copies the
template, writes the configuration from the spec and `.atlas/genesis.json`
(template, version, spec digest), then runs `git init -b main` and makes an
initial commit as Atlas. No remote is involved. `commitWorkspace` commits
each later change.

## Execution (`executor.mjs`, `preview.mjs`, `inspector.mjs`, `coder.mjs`)

Once a plan is approved, the daemon runs the project by itself:

1. **Scaffolding.** It creates the workspace (a changed project is
   reconfigured in place), commits it, and records the folder, template and
   commit as evidence.
2. **Building.** Tasks run in dependency order.
   - `template` tasks are provided by the template configuration and stay
     "running" until the checks confirm them.
   - `coder` tasks go to Atlas's existing coder (`atlas code`, driven through
     `createCoderBuilder` exactly as self-improvement drives it). Each task is
     one bounded objective with its verification criteria, gets at most two
     attempts, and each result is committed.
   - With no reachable model, the task and the project become **blocked**,
     with the reason recorded; resuming continues from there.
3. **Verifying.** The template's `check`, `test` and `build` run through the
   shell-free `runCheck`. The evidence records the exit codes, durations, test
   counts and output tails.
4. **Repairing.**
   - A failure becomes a repair objective that carries the real output, plus
     the Intelligence Layer's `explainFailure` summary.
   - The repair is judged by the self-improvement change policy, restricted to
     the rules that protect verification: no deleted tests, no fewer tests,
     nothing secret-shaped, and nothing under `.atlas/` or `.git/`. A
     violation rolls the repair back.
   - Repairs stop at the project's budget (3 by default), and the project then
     **fails** with the evidence. `retry` gives it a fresh budget.
5. **Previewing.** `PreviewManager` allocates a free loopback port and starts
   the template's preview command without a shell, using the minimal
   environment. It considers the app started only when the health URL answers
   200; an early exit or a timeout is a failed start with the logs, which goes
   to repair.
   - Previews are recorded in `previews.json`. On the next start, orphans are
     stopped, but only when `/proc` confirms the process is that preview.
6. **Reviewing.** `createInspector` opens the app in Chromium (Playwright from
   `apps/browser-worker`).
   - It checks every page at 1280px and 375px for status, the expected
     heading, console errors, uncaught exceptions and horizontal overflow.
   - It drives the critical workflows through the real UI: add a record and
     find it by search, book an appointment, send an enquiry (empty and
     valid).
   - It saves screenshots outside the project for a later vision pass.
   - Without a browser it falls back to HTTP checks and marks the result
     `limited`; the final summary says so. APIs are fully checked over HTTP.
   - Findings (`{ check, page, expected, observed, severity }`) go to repair
     like any failure.
7. **Polishing.** With a model, one bounded polish pass runs after a clean
   review, and is then verified and reviewed again. Without a model it is
   skipped, and the summary says so.
8. **Ready** only when every task has passed or was skipped with a reason. The
   ready evidence is the owner's summary: preview URL, folder, features,
   pages, checks with test counts, inspection mode, repairs and limitations.

The coder's model comes from `intelligence.modelFor` when that answers, then
the owner's applied model plan by difficulty (through the existing
`agent/models/difficulty.mjs`), then `ATLAS_GENESIS_MODEL` or the default
local model. The endpoint is the local model server unless the owner sets
`ATLAS_GENESIS_BASE_URL`, so paid APIs are never used silently.

## Testing with the real coder and a browser

`tests/genesis-coder.test.mjs` runs Atlas's **real** coder (`atlas code`),
built and spawned as in production. It talks to a scripted
OpenAI-compatible model server (`tests/helpers/scripted-model-server.mjs`),
so only the model's answers are fixed. It proves three things:

1. A planted bug is repaired. The repair objective names the failing test,
   the coder's change set is applied and verified, and Genesis re-checks and
   reaches ready.
2. A sign-in task is built by the coder, and its tests run with the app's
   own.
3. A visual problem reported from the screenshots is fixed in the
   stylesheet by the coder, and the app is checked again. The second
   review's suggestion is reported without blocking.

The **Genesis** CI job installs the coder CLI and Chromium and runs every
Genesis test with `GENESIS_REQUIRE_FULL=1`, so nothing can skip. It also
runs the benchmarks on the template path.

## Running the benchmarks with a real local model

Model downloads are blocked in Atlas's cloud sandbox, so the benchmarks run
there without a model. On your own machine:

1. Open **Models** and press **Use this plan**, installing what it
   recommends. Add `qwen2.5vl:7b` if you want the visual review.
2. Run `node scripts/local/genesis-bench.mjs`. Add `--keep` to keep the
   generated projects, or `--only crud,auth-app` to run a subset.
3. Results go to `~/.atlas/genesis/benchmarks/<time>.json`. They record
   completion, build, test counts, browser verification (and whether a
   visual review ran), repairs, time, the models the coder used, and any
   human intervention. The authenticated app is the scenario that needs the
   coder: sign-in is a coder task.

## PR sequence

1. **Lifecycle, durable store, requirements, plan, routes** (`/v1/genesis`). Done in this PR.
2. **Local workspace and curated templates** (`web-app`, `static-site`, `api-service`). Done: see "Templates" below.
3–6. **Executor, verify/repair loop, preview manager and browser verification.** Done: see "Execution" below.
7. **Visual review.** Done: `vision.mjs`.
   - After a clean browser inspection, a vision-capable local model (for
     example `qwen2.5vl:7b`, or `ATLAS_GENESIS_VISION_MODEL`) reviews up to 6
     screenshots, phone widths first. It checks a fixed list: overflow,
     overlap, unreadable text, broken spacing, missing content, unfinished
     default UI, broken phone layouts and error pages.
   - Its answer must be JSON; anything else is recorded and ignored.
   - Only issues it marks as errors can block, and only on the project's first
     review. That triggers one repair; after that, visual issues are
     suggestions passed to polish and listed as limitations.
   - Without a vision model the review is skipped, and the summary says so.
8. **Live Genesis UX.** Done:
   - **Build** page in the local app: prompt box with examples, plain
     progress (✓ / ● / ✗ / – per step), answer form for open questions,
     **Open the application**, what was verified, limitations, files, **Ask
     for a change**, pause/resume/cancel/retry/approve, and expandable
     assumptions and technical details (every transition with its evidence).
   - **Chat tools** `genesis.build`, `genesis.status`, `genesis.change` and
     `genesis.answer` (capability `genesis.build`, allowed by default).
     "Add Google login" continues the most recent project.
9. Publishing handoff through the existing adapters and approvals.
10. **Benchmarks.** Done: `node scripts/local/genesis-bench.mjs` runs the five scenarios (marketing site, CRUD, dashboard, REST API, authenticated app) for real. It records completion, build, test counts, browser verification, repairs, time, models used and human intervention in `~/.atlas/genesis/benchmarks/`. The first baseline, with no model available: 4/5 ready, 3 browser-verified and the API verified over HTTP, 0 repairs. The authenticated app correctly blocks until a coding model is set up.
