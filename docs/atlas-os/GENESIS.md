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

### Repair loop limits (`platform/loop-policy.mjs`, issue #355)

Before each repair starts, `decideIteration` checks, in order:

| Stop reason | When |
|---|---|
| `iteration-limit` | the project's repair budget (default 3) is used |
| `time-limit` | the build cycle has run `ATLAS_REPAIR_MAX_MINUTES` (default 360) |
| `spend-limit` | repairs used `ATLAS_REPAIR_MAX_TOKENS` model tokens (default: no token limit) |
| `no-progress` | the same failure has survived 2 repairs |

"The same failure" is a fingerprint of stage, check, exit code and the failure
output with timings, line numbers, hashes and paths removed. Token use comes
from the coder's own audit trace; a repair whose trace is unreadable is counted
as unmetered in the receipt, not as free. The final `failed` transition carries
`evidence.loop` (reason, iterations, elapsed time, tokens, unmetered count,
fingerprint). A rolled-back repair's broken rules are fed into the next repair
objective. Retrying a project from the UI starts a new cycle.

## Persistent environments (`platform/environments/`, issue #351)

A Genesis project is a persistent environment: it can stop and resume later
with its files, state and checkpoints intact.

- **Contract** (`environment.mjs`): `describe · exec · files · snapshot ·
  restore · destroy`, with declared capabilities. Genesis runs on
  `LocalEnvironment` (`local.mjs`). `CloudflareSandboxEnvironment`
  (`cloudflare.mjs`) is the cloud implementation; it is **not live until the
  owner deploys it** (see "Cloud environments" below). Until then, asking for
  `cloudflare-sandbox` returns `UNAVAILABLE` with that reason.
- **Snapshot.** When each stage starts (scaffolding on a change, building,
  verifying, repairing, previewing, reviewing) and when the project becomes
  ready, the executor commits the workspace. The commit is copied into
  `<data>/genesis/snapshots/<projectId>.git` (ref
  `refs/atlas/snapshots/<n>`), so deleting the folder loses nothing that was
  snapshotted. Each snapshot records two digests:
  - the tree digest: sha256 over every tracked path, its mode and the
    sha256 of its bytes on disk;
  - the manifest digest: the manifest in canonical JSON. The manifest holds
    the state, plan, task statuses, repair count, last verified check, and
    the side effects that are in flight or done.
  The snapshots are rows in `genesis_snapshots`.
- **Restore** puts the snapshot into a *fresh* folder, recomputes both
  digests from what was written, and fails closed on any mismatch: it leaves
  nothing behind and the project does not move. Git copies local objects
  without re-hashing them, so this digest check is what catches a tampered
  snapshot store.
- **Resume receipt.** On daemon start, `executor.recover()` does two things:
  - it pauses interrupted projects, as before;
  - for each project whose latest snapshot was taken at the start of the
    interrupted stage, it restores that snapshot, resets the task statuses
    to the manifest, and moves `paused → <stage>`. That transition carries
    `evidence.kind = "resume-receipt"`: the snapshot, both digests, the new
    and previous folders, the last verified check, and the completed and
    in-doubt effects.
  The previous folder is kept for inspection. If verification fails, the
  project goes to `blocked` with `resume-refused` evidence instead. Owners
  can also call `POST /v1/genesis/:id/restore`. For a ready, published or
  failed project, that returns to `building` on the restored files, so the
  project is verified again.
- **Side effects never repeat.** External actions go through
  `executor.effect(projectId, key, perform)`, which is also passed to the
  coder as `effect`. The ledger lives in `genesis_effects`:
  - an effect recorded as done returns its receipt without running again;
  - one claimed but never completed is *in doubt*, and the build is blocked
    (`EFFECT_IN_DOUBT`) until `store.resolveEffect` settles it;
  - one that failed may run again.
- **Not in a snapshot:** ignored files (`node_modules/`, `dist/`, `data/`).
  Verification reinstalls and rebuilds them, so a running app's local data
  is not carried over. Digests are not signed: someone who can write both
  the database and the snapshot store can forge both.

## Cloud environments: Cloudflare Sandboxes (decision D2, issue #351)

**Status: built and tested, off by default, not live.** Cloudflare
Sandboxes need the Workers Paid plan ($5/month). Until the owner enables the
sandbox build and deploys, the Worker carries no container code and every
broker call answers `503 UNAVAILABLE` with the reason ("needs the Workers
Paid plan, the sandbox build and a deploy"). The local client then also
reports `UNAVAILABLE`. Atlas never falls back from a sandbox to the host.

It uses Sandbox SDK **1.0** (`@cloudflare/sandbox@1.0.0`, pinned). In 1.0
the 0.x `getSandbox()` / `exec()` / `exposePort()` / `createBackup()` calls
are gone. Instead:

- our own Durable Object (`AtlasSandbox`) starts its container through
  `ctx.container` (`durable_object` scheduling policy) and runs commands
  with `ctx.container.exec(argv)`;
- `Files` reads and writes files;
- `DirectoryBackup` saves snapshots to R2;
- previews go through `getTcpPort(port).fetch()`.

### How it fits together

| Piece | File | Job |
|---|---|---|
| Client | `apps/local-control/src/platform/environments/cloudflare.mjs` | `CloudflareSandboxEnvironment`: the Environment contract over HTTPS, plus the migrations below |
| Broker | `apps/web/app/api/sandbox/broker.mjs`, routes `app/api/sandbox/[id]` and `[id]/[operation]` | Owner-only auth, the tenant-scoped sandbox name `t<tenantId>-<id>`, input validation |
| Sandbox object | `apps/web/worker/sandbox-core.mjs`, `sandbox-object.mjs` | One container per environment: exec, files, tree, snapshot, restore, destroy, preview |
| Image | `apps/web/sandbox/Dockerfile`, `tree-manifest.mjs` | Node 24 + git + coreutils; `sandbox-shim` 1.0.0; the tree helper |
| Build switch | `apps/web/sandbox.config.json`, `sandbox/wrangler-sandbox.mjs`, `worker/index-sandbox.ts` | Adds the container, Durable Object, migration and R2 bucket only when enabled |

### Behavior and guarantees

- **Auth.** The routes accept only the deployment owner: the operator token
  as a Bearer credential, or an operator session. This is the same gate as
  the Genesis node routes. A sandbox runs arbitrary code.
- **Tenancy.** The tenant comes from the caller's resolved workspace, never
  from the request body. Each tenant's snapshots sit under their own R2 prefix
  `tenants/<id>/`, so a backup record from another tenant does not restore.
- **exec**
  - Takes argv only, never a shell line.
  - Runs under GNU `timeout`, which also stops any processes the command
    starts. A hard SIGKILL follows if needed.
  - Time is 1 s to 30 min, default 10 min. Output is capped at 1 MiB per
    stream (default 256 KiB), and `truncated` reports when the cap was hit.
  - The container starts with Internet access **off**, unless the
    environment was created with `internet: true`.
- **files**
  - Paths are relative to `/workspace/project`.
  - `..`, absolute paths and `.git/` are refused.
  - Paths are also resolved with `realpath` inside the container, so a
    symlink cannot lead out of the workspace.
  - Files over 8 MiB are not transferred.
- **snapshot**
  - The workspace is saved with `DirectoryBackup` (R2, `tar+zstd`), keeping
    `.git` and leaving out gitignored files. The record carries R2's sha256
    of the archive.
  - The tree entries come from `tree-manifest.mjs`: path, git mode and the
    sha256 of each file.
  - The client turns those entries into the tree digest with
    `digestTreeEntries`, the same function `LocalEnvironment` uses. A
    workspace therefore digests identically in either place; a test proves
    this on a real repository.
- **restore**
  - Goes only into a *fresh* sandbox; an existing one gets `409 EXISTS`.
  - The SDK checks the archive's sha256. The client then recomputes the tree
    digest and compares it to the snapshot's.
  - On any mismatch the fresh sandbox is destroyed and the restore fails
    closed with `DIGEST_MISMATCH` or `BACKUP_INTEGRITY`.
- **Migration.** Both directions are verified against the same digest.
  - `migrateLocalSnapshotToCloud` reads the files from the local snapshot
    repository and checks them against the snapshot's digest *before*
    uploading anything, which catches a tampered store. It then uploads them
    to a fresh sandbox and checks the cloud tree.
  - `migrateCloudSnapshotToLocal` restores into a temporary sandbox,
    downloads the files, commits them to a fresh folder, and checks the local
    digest. The temporary sandbox is always destroyed.
  - Symlinks and submodules are refused (`UNSUPPORTED`) for now.
- **destroy** removes the container and the object's record. Snapshots in
  R2 are kept.
- **Previews.** A preview is served at `https://<port>-<token>.<previewDomain>/`.
  - The token is 128 random bits. It is stored in the sandbox and in a
    registry object, and checked in constant time.
  - Each preview is its own origin, so it never sees the app's cookies.
  - Previews need a custom domain with a wildcard DNS record and route.
    Without one, `preview` answers `PREVIEW_NOT_CONFIGURED`.
- **Credentials.**
  - The client reads `ATLAS_CLOUD_SANDBOX_URL` and the token
    `ATLAS_CLOUD_SANDBOX_TOKEN`, from the environment or the credential
    vault.
  - The URL must be https; plain http is allowed only on loopback, for tests.
  - The token is the Worker's `ATLAS_OPERATOR_TOKEN`. It is held privately,
    sent only as the Authorization header, and scrubbed from every error,
    even when the broker echoes it.

### Owner steps to turn it on

1. **Plan.** Move the Cloudflare account to Workers Paid (Containers require it).
2. **R2 bucket.** `npx wrangler r2 bucket create atlas-sandbox-backups`, or use
   another name and set `backupBucket` in `apps/web/sandbox.config.json`.
3. **API token.** The `CLOUDFLARE_API_TOKEN` repository secret that deploys the
   Worker needs Containers edit and R2 edit permissions as well as Workers.
4. **Enable the build.** Set `"enabled": true` in `apps/web/sandbox.config.json`.
   Optionally set `"previewDomain": "<a domain you own>"`, add a wildcard DNS
   record and a Worker route `*.<domain>/*` for it.
   - The file is not a protected path. Enabling it with no paid plan makes
     the deploy fail, so only the owner should flip it.
   - The deploy workflow (`deploy-cloudflare.yml`, protected) needs **no
     change**: it already builds with `npm run build` and deploys
     `dist/server/wrangler.json`. GitHub's `ubuntu-latest` runner has the
     Docker that `wrangler deploy` uses to build the image.
5. **Deploy.** Merge to `main`, or run "Deploy Atlas web to Cloudflare Workers".
   - No new Worker secret is needed: the broker uses `ATLAS_OPERATOR_TOKEN`,
     which is already uploaded.
6. **Point the daemon at it.** On the machine running the daemon, set
   `ATLAS_CLOUD_SANDBOX_URL=https://<your Worker host>`, and store the
   operator token as `ATLAS_CLOUD_SANDBOX_TOKEN` in the credential vault (or
   the environment).
7. **Check it.** `curl -H "Authorization: Bearer $TOKEN" -X POST https://<host>/api/sandbox/smoke`
   should answer `{ "exists": true, ... }` rather than `503 UNAVAILABLE`. Then
   delete the sandbox with `DELETE /api/sandbox/smoke`.

The binding the enabled build adds (generated into `dist/server/wrangler.json`):

```jsonc
{
  "main": "./worker/index-sandbox.ts",
  "containers": [{ "name": "atlas-sandbox", "class_name": "AtlasSandbox", "scheduling_policy": "durable_object",
                   "images": { "atlas": { "dockerfile": "<abs path>/apps/web/sandbox/Dockerfile" } } }],
  "durable_objects": { "bindings": [/* INFERENCE_GOVERNOR, */ { "name": "ATLAS_SANDBOX", "class_name": "AtlasSandbox" }] },
  "migrations": [/* v1-inference-governor, */ { "tag": "v2-atlas-sandbox", "new_sqlite_classes": ["AtlasSandbox"] }],
  "r2_buckets": [{ "binding": "ATLAS_SANDBOX_BACKUPS", "bucket_name": "atlas-sandbox-backups" }],
  "vars": { "ATLAS_SANDBOX_PREVIEW_DOMAIN": "<previewDomain, only when set>" }
}
```

**Turning it off after it has been deployed** is not just `"enabled": false`.
The deployed `AtlasSandbox` class must first be deleted with a migration
`{ "tag": "v3-remove-atlas-sandbox", "deleted_classes": ["AtlasSandbox"] }`,
and that deletes every sandbox's record. The snapshots in R2 survive.

### Known limits

- Snapshot digests come from a helper inside the sandbox. A compromised
  sandbox could lie about its own tree. The archive's sha256 is checked by
  the SDK, but the archive is also produced inside the sandbox.
- Files move as base64 JSON, at most 8 MiB each.
- Genesis does not yet choose the cloud kind on its own: it needs an explicit
  `resolveEnvironmentKind("cloudflare-sandbox")` from a caller.

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

## Rendering from a project (`platform/render/routes.mjs`)

The daemon builds a `RenderRunner` at startup. It only runs inside the container sandbox:
- `ATLAS_TERMINAL_CONTAINER_RUNTIME`: the same runtime the terminal sandbox uses;
- `ATLAS_RENDER_FFMPEG_IMAGE`, `ATLAS_RENDER_BLENDER_IMAGE`: one image per tool.

Without a runtime and an image it reports itself unavailable and never runs on the host.

- `GET /v1/render`: `{ available, reason, capabilities }`. Paired devices may read it.
- `POST /v1/render/jobs` `{ projectId, job }`: owner only (a paired device gets 403). It renders against that project's workspace. Video outputs go into the artifact store with the project id as provenance. The response codes:
  - 200: the render succeeded.
  - 422: the render ran but failed.
  - 503: no sandbox, or no image configured.
  - 400: the job was refused by the render policy.

`tests/sprint-journey.test.mjs` runs the cross-lane journey through the real HTTP handler: sentence → verified project → sandboxed render → video artifact (Range-served) → workspace lost → restore from snapshot → render again. In CI the container runtime is a stand-in; the real-container render is in `platform-render.test.mjs`.
