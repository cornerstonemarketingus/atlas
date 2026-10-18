# Atlas engineering plan, Q4 2026 (proposal)

Written 2026-10-18 by the lead-engineer session at the owner's request. It
improves the owner's five upgrades (persistent environments, universal
execution, GPU compute, artifacts and previews, autonomous improvement loops)
and fits them into [`PROGRAM.md`](PROGRAM.md) and [`ROADMAP.md`](ROADMAP.md).
**Status: proposal.** PROGRAM.md stays the governing program until the owner
adopts or amends it. Nothing here weakens PROGRAM.md's protected paths,
testing rules or never-list.

## 1. Diagnosis: what actually limits Atlas

Atlas does not lack ideas. It already has about 74,000 lines of non-test
source, 31 platform modules, a kernel with typed world state, Genesis
(prompt to running app), missions, automations, goals that sleep and wake, a
mobile shell, a hosted Worker and an inference governor package. Every test
suite was green on 2026-10-18 (web 498, local-control 764, CLI 540,
inference 63, runner 81, mobile 23, browser-worker 20, companion 41).

What holds it back:

| Constraint | Evidence | Cost |
|---|---|---|
| **Nothing is measured** | No eval baseline until #348 (10 tasks, no model run yet). PROGRAM 2.1 calls the eval harness the gate for everything after it | Routing, model and loop changes cannot be shown to help |
| **Integration debt** | About 30 open PRs and 58 open issues. Hosted execution alone is a chain of about 10 overlapping PRs (#260 to #302). ROADMAP marks several modules "built, not wired" | Work lands slowly; merges conflict; it is unclear what is live |
| **Gates wait on the owner** | Phase 0 exit gate (deploy plus a live session), the GitHub dispatch credential, the Phase 1 PR stack, protected workflow reviews (#320, #349) | Finished work does not reach production |
| **Two runtimes for one idea** | Hosted (Worker, D1, GitHub Actions coder) and local (daemon, SQLite, Genesis, missions) each keep their own task, mission and claim state | Every feature gets built twice, or works in only one place |
| **Unbounded loops** | Each loop had its own retry count and no time, spend or no-progress limit, until #356 | Runaway cost; agents re-fixing the same failure |

**The revolutionary move is not more surface. It is making every Atlas run
persistent, verified, bounded and visible, measured by cost per verified
outcome, on one runtime that works the same locally and in the cloud.**

## 2. North-star metrics (published weekly from Wave 0)

1. **Verified success rate** on the eval suite (`packages/atlas-eval`): a
   pass means the task's own checks pass, never the agent's claim.
2. **Cost per verified outcome:** tokens, money and compute divided by
   verified passes (Track B's stated metric, made concrete).
3. **Time to first visible artifact:** from prompt to something the user can
   open (a preview, a player, a PR).
4. **Resume rate:** the share of interrupted runs that resume with no
   repeated side effects.
5. **Runaway incidents:** loops stopped by a limit versus loops that hit a
   provider or billing error first. The target is zero of the second kind.

## 3. Target architecture: one run contract, five planes

```
            ┌──────────────────── Atlas Run ────────────────────┐
  Goal ───▶ │ policy · budget · loop limits · checkpoints · receipts │ ──▶ Delivery
            └──┬─────────┬───────────┬───────────┬────────────┬──┘
     Intelligence   Execution    Compute     Artifacts    Protocols
     (governor)   (environments) (GPU jobs)  (store+viewers) (MCP/A2A)
```

**The Atlas Run** is the kernel run that already exists (`agent/kernel/`),
extended with what every run must carry: `Goal + Policy + Budget +
LoopPolicy + Environment + Capabilities + Checkpoints + Receipts`. Chat,
coding, Genesis, automations and goals all start runs. Local and cloud
execute the same contract. This is ROADMAP Track B1/B12 carried through to
the hosted side, not a new abstraction.

### 3.1 Execution plane: persistent environments (upgrades 1 and 2 merged)

Upgrades 1 (persistent creation environments) and 2 (universal execution)
are one system: **an Environment is a persistent, snapshot-able sandbox with
capabilities mounted into it.**

- **Interface:** `create · exec · pty · files · preview(port) · snapshot ·
  restore · sleep · destroy`, with capabilities declared per environment
  (`terminal`, `browser`, `dev-server`, `ffmpeg`, `blender`, `godot`, `gpu`).
- **Local implementation:** the existing container and namespace sandboxes
  (`platform/terminal/`), plus git commits and a tarball digest as the
  snapshot.
- **Cloud implementation:** **Cloudflare Sandboxes**, generally available
  since 2026-04-13. They are persistent Linux containers addressed by a
  stable ID that sleep when idle and wake on request. They offer snapshot
  recovery, live preview URLs, PTY terminals, filesystem watching, credential
  injection and pricing for active CPU only. Atlas already runs on Workers and
  Durable Objects, so this is the lowest-friction cloud environment
  available. It replaces "GitHub Actions as the coder's computer" for
  interactive work. Actions stays for PR CI.
- **Resume = restore + replay-safe continuation:** checkpoints record
  environment snapshot, plan state, last verified check and pending
  side-effect intents. External actions use the idempotency and claim
  receipts already built on the hosted side (#267, #277) and in local
  missions.
- **Engines and renderers:** headless ffmpeg, Blender (Cycles or EEVEE) and
  Godot export run as images inside the sandbox. They are bounded by time
  and output, and their artifacts are written to the workspace. The never-list
  rule that a sandbox never falls back to the host applies unchanged.
- **Migration** (ROADMAP B6) follows naturally: snapshot locally, restore in
  the cloud, and the reverse.

### 3.2 Compute plane: GPU jobs that cannot outlive their budget (upgrade 3)

- **Provider interface:** `estimate · provision · status · terminate ·
  listTagged`. The first real adapters are serverless GPU providers with
  per-second billing and scale-to-zero (RunPod, Modal, or the provider the
  owner picks).
- **Four independent stops,** so no single failure leaves a bill running:
  1. a budget reservation before provisioning (reuses `platform/budget.mjs`
     and the cumulative budgets in #338);
  2. a max lifetime set on the provider side at creation, so a crashed
     Atlas still stops billing;
  3. an idle timeout driven by a job heartbeat;
  4. a reconciler that lists Atlas-tagged instances and terminates any
     without a live lease. It runs on a schedule and at daemon startup.
- **Verify before committing to a provider:** GPU drivers, Blender with
  Cycles on CUDA/OptiX inside the provider's containers, and the asset
  upload/download path. This is unverified today.
- PROGRAM lists a "hosted GPU fleet" as deferred. This is rented rendering
  compute, not an owned fleet, but the owner should confirm the phase
  (decision D4).

### 3.3 Artifact plane: show the thing, everywhere (upgrade 4)

- **Typed, content-addressed artifacts:** an `Artifact` contract in
  `packages/atlas-contracts` (kind: website, app, game, video, model3d,
  document, file; sha256; size; provenance run and step; preview URL). The
  bytes live in a content-addressed store (R2 in the cloud, the data directory
  locally).
- **Viewers:** a live preview for websites and apps (a Genesis preview
  locally, a Sandbox preview URL in the cloud); `<video>` for mp4 and webm;
  `<model-viewer>`/three.js for glTF; an HTML5 game frame for
  web-exported games; a temporary deployment for apps.
- **Distribution through MCP Apps.** The MCP Apps extension lets a server
  declare `ui://` resources that hosts render in sandboxed iframes. The
  official client list includes Claude, VS Code GitHub Copilot and Microsoft
  365 Copilot. If Atlas's MCP server serves artifact viewers as MCP Apps, a
  user sees and iterates on Atlas's output inside the tools they already use,
  without downloading anything.
- **Iterate in place:** "change this" on a viewer becomes a new run against
  the same environment, which is why the environment must persist.

### 3.4 Loop plane: bounded, verifying improvement loops (upgrade 5)

User → Create → Execute → Inspect → Test → Improve → Deliver, with:

- **One LoopPolicy:** iterations, wall time, tokens or money, and no
  progress (the same normalised failure fingerprint survives N repairs).
  It is checked before each iteration. Shipped for Genesis in #356; next for
  the coder CLI, then automations and goals.
- **Verifiers, not opinions:** each loop step ends in a check that the loop
  cannot fake: tests, a build, a browser inspection, a render checksum, or
  frames sampled from a video. A model judging itself does not count.
- **Escalation over repetition:** after a no-progress stop, escalate (a
  stronger model, a different strategy, or ask the owner) instead of
  retrying. The independent-reviewer quorum (Track B11) is used only where
  the eval shows it raises verified success per dollar.
- **The delivery receipt states why the loop stopped** and what is
  verified versus only claimed (extends #339).

### 3.5 Intelligence plane: one governed gateway

- Every model call goes through `packages/atlas-inference` (the Phase 1
  governor): quota-aware queueing, circuit breakers, fallbacks and usage
  records. Track B12 "Atlas Gateway" is this, widened to MCP, A2A, browser
  and compute calls.
- Route by measured results: the eval suite runs on every routing or
  inference change (PROGRAM 2.1), and background evals use batch APIs
  where the provider offers them.
- Local inference (Ollama, llama.cpp) stays first-class for free and
  private work. **Browser-side inference** through WebGPU (WebLLM,
  Transformers.js) is an experiment for zero-cost small tasks on capable
  clients. WebGPU is broadly available in 2026 but uneven on Linux and
  mobile, so it needs a server fallback.

### 3.6 Protocol plane: speak the 2026 agent internet

- **MCP 2026-07-28:** a stateless core (any server instance can handle any
  request), the Tasks extension for long-running async work, MCP Apps for UI,
  and stricter OAuth. Roots, Sampling and Logging are deprecated. Migrate
  Atlas's MCP client and server, expose Atlas runs as MCP Tasks, and expose
  artifact viewers as MCP Apps.
- **A2A v1.0** with signed agent cards: publish an Atlas agent card and
  accept delegated tasks (ROADMAP B3). Reported adoption is 150+
  organizations with integrations on the major clouds.
- **Payments** (AP2, ACP, x402): status and real usage are unclear in
  October 2026. Keep them deferred behind the existing payments budget and
  approvals.
- **Observability:** emit OpenTelemetry traces using the GenAI and MCP
  semantic conventions. These were still labelled "Development" in August
  2026, so pin a version and keep the mapping in one module.

## 4. What makes this revolutionary (and defensible)

1. **Verified outcomes as the product.** Every run ends in receipts that
   separate verified from claimed, and the eval pass rate and cost per
   verified outcome are published. Most agents report what they intended;
   Atlas reports what is proven.
2. **Work that survives.** Projects live in persistent environments that
   resume after a crash, the next day, or on a different computer (local to
   cloud migration).
3. **It shows the work.** Games play, videos play, sites run and 3D models
   rotate, in Atlas and inside other AI clients through MCP Apps.
4. **Autonomy with an economy.** Loops, GPU jobs and agents run inside
   hard budgets enforced before spending, with provider-side kill switches.
   Atlas is safe to leave running.
5. **It grows its own body.** The capability loop (ROADMAP) turns a
   repeated gap into a reviewed, digest-approved skill that every future
   run can use.

## 5. Sequencing: four waves, each with an exit gate

Waves follow PROGRAM.md's rule that a gate must pass before the next wave
starts. Phase 3 items are pulled forward only with the owner's explicit
override (decision D1).

### Wave 0: stabilize and measure (weeks 0–2)

- Owner unblockers: deploy, the GitHub dispatch credential, a provider key
  as a repository secret, and reviews of the protected PRs (#349 eval
  workflow, #320 native compile, #311 sandbox).
- PR and issue triage: merge or close every open PR older than 7 days. Fold
  the hosted-execution chain (#260 to #302) into as few PRs as possible.
  Close issues duplicated by #351 to #355.
- Wire or delete every module ROADMAP marks "built, not wired" (skills
  registry, MCP gateway, Atlas MCP server, engineering review scans).
- Eval: a baseline run against production, then grow from 10 to 30 tasks,
  adding Genesis tasks (prompt to app that passes its tests), test repair,
  tool arguments and final synthesis.
- **Gate:** baseline published in `docs/EVALS.md`; fewer than 10 open PRs;
  Phase 0 exit gate recorded.

### Wave 1: one run contract and persistent environments (weeks 2–6)

- The Environment interface with local and Cloudflare Sandbox
  implementations; snapshot and restore; the resume receipt (#351).
- LoopPolicy in the coder CLI's repair loop and in automations (#355
  continued).
- MCP 2026-07-28 migration of the client and server.
- **Gate:** a chaos test kills the daemon or container mid-task, resumes
  locally and in the cloud, and repeats no external side effect. The eval
  shows no regression.

### Wave 2: execution engines and artifacts (weeks 6–10)

- ffmpeg and Blender images in the sandbox, then Godot web export (#352).
- The Artifact contract, the content-addressed store, viewers for video,
  glTF and game, and artifact viewers served as MCP Apps (#354).
- Genesis templates for an HTML5 game and a rendered video.
- **Gate:** one sentence to a playable game preview, and one sentence to a
  rendered video, each verified by an inspector check (the game loads with
  no console errors and accepts input; the video has the expected duration
  and frames that are not blank).

### Wave 3: GPU compute and cloud scale (weeks 10–14)

- The GPU manager (#353): a fake provider first, then one real provider,
  with all four stops.
- Long cloud runs on durable execution (Cloudflare Workflows on Durable
  Objects), so a run outlives any single request or container.
- A2A agent card; OpenTelemetry export; a cost-per-verified-outcome
  dashboard.
- **Gate:** a GPU render job runs end to end within its budget, and a chaos
  test (killing Atlas mid-job) leaves zero orphan instances after the
  reconciler runs.

## 6. Engineering rules for this plan

- **Work-in-progress limit:** at most 3 open PRs per agent, and none older
  than 7 days without an explicit reason on the PR.
- **No new subsystem without a vertical slice:** wired, reachable, tested at
  its real boundary, documented (PROGRAM §2). "Built, not wired" is not done.
- **Every inference, routing or loop change carries an eval delta** in its
  PR description.
- **Interfaces before vendors:** Cloudflare Sandboxes, the GPU providers and
  the model providers sit behind Atlas interfaces with a local
  implementation, so Atlas stays local-first and portable.
- PROGRAM.md's never-list and protected paths are unchanged.

## 7. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Pull Phase 3 items (#351, #352, #354) forward before the Phase 2 exit gate? | Yes, through the waves above, once Wave 0's gate passes |
| D2 | Adopt Cloudflare Sandboxes as the cloud Environment? | Yes, behind the interface. Verify pricing on a 2-week pilot |
| D3 | Move interactive hosted coding from GitHub Actions to Sandboxes plus Workflows? | Pilot in Wave 1, decided by eval and latency; keep Actions for CI |
| D4 | GPU compute: confirm its phase, pick a provider and set a monthly cap | Confirm for Wave 3, starting with a small cap |
| D5 | Adopt the WIP limit and weekly metrics? | Yes |
| D6 | Amend PROGRAM.md to reference this plan? | After Wave 0, if the plan holds up |

## 8. Risks

| Risk | Mitigation |
|---|---|
| Vendor lock-in (Cloudflare) | Environment interface with local parity; snapshots in an Atlas-owned format |
| Spec churn: MCP made breaking changes in 2026-07-28; OTel GenAI is still Development | One adapter module per spec, with pinned versions and contract tests |
| Cost overruns (sandboxes, GPU, models) | Budget reservation before spend, provider-side lifetimes, a reconciler, weekly cost per outcome |
| Untrusted generated code | Sandboxes only; network off by default; credentials injected by proxy, never written to disk; no host fallback |
| Benchmark hype | Atlas's own eval decides; public leaderboard numbers conflict across sources |

## Appendix: 2026 technology check (as of 2026-10-18)

Facts this plan relies on, with confidence. Re-verify before building on
any of them.

| Fact | Confidence | Source |
|---|---|---|
| MCP spec 2026-07-28: stateless core, Tasks and MCP Apps extensions, Roots/Sampling/Logging deprecated, stricter OAuth | Medium-high (consistent secondary sources; read the official spec before migrating) | [AAIF](https://aaif.io/blog/mcp-2026-07-28-whats-changing-and-how-to-migrate), [mcpservers.org](https://blog.mcpservers.org/posts/mcp-spec-2026-07-28) |
| MCP Apps: `ui://` resources rendered in sandboxed iframes; clients include Claude, VS Code Copilot, M365 Copilot | High | [modelcontextprotocol.io](https://modelcontextprotocol.io/extensions/apps/overview) |
| Cloudflare Containers and Sandboxes GA 2026-04-13 (snapshots, preview URLs, PTY, credential injection, active-CPU pricing) | High | [Cloudflare changelog](https://developers.cloudflare.com/changelog/2026-04-13-containers-sandbox-ga), [InfoQ](https://infoq.com/news/2026/04/cloudflare-sandboxes-ga) |
| Cloudflare Workflows rebuilt for 50,000 concurrent instances; Durable Object Facets | Medium | [ecorpit guide](https://ecorpit.com/cloudflare-agents-sdk-durable-objects-production-guide-2026/), [softprom roundup](https://softprom.com/cloudflare-agents-week-2026-20-new-features-for-ai-agents) |
| A2A v1.0 with signed agent cards; 150+ supporting organizations | Medium-high | [Linux Foundation](https://linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year) |
| Serverless GPU with per-second billing and scale to zero (RunPod, Modal); Blender support unverified | Medium | [RunPod](https://runpod.io/product/serverless), [Prem AI comparison](https://blog.premai.io/serverless-llm-deployment-runpod-vs-modal-vs-lambda-2026) |
| OpenTelemetry GenAI and MCP conventions still "Development" (August 2026) | Medium | [TrueFoundry](https://www.truefoundry.com/blog/opentelemetry-genai-semantic-conventions), [Greptime](https://www.greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions) |
| WebGPU broadly available; uneven on Linux and mobile; WebLLM and Transformers.js current | Medium | [Pinggy](https://pinggy.io/blog/run_llm_in_browser_webgpu/), [tianpan.co](https://tianpan.co/blog/2026/04/17/browser-native-llm-inference-webgpu) |
| AP2 and agent payments: maturity and real volume unclear | Low | [Blindpay comparison](https://blindpay.com/resources/more/agent-payment-protocols-compared) |
| Coding-agent leaderboards (Terminal-Bench 2.x, SWE-bench Pro): numbers conflict across sources | Low | [Morph](https://www.morphllm.com/terminal-bench-2), [Codesota](https://www.codesota.com/benchmark/terminal-bench) |
