# Atlas — Build it. Run it. Grow it.

**An autonomous software platform. From idea to operation.**

Atlas turns goals into working software and repeatable digital work. It brings
repositories, websites, applications, agents, tools and computer control into
one platform: plan the work, create the product, test it, repair failures and
carry the result forward through approved publishing and persistent automation.

**Give it a goal. Build what comes next.**

Software creation is the foundation. The larger ambition is **autonomous
business creation**: turn an idea into a product, launch it, connect its customer
and operational workflows, then keep improving it. Websites, full applications,
games and other digital products belong in that vision. Supported website/app/API
creation works today; a dedicated game-creation workflow and complete business
operation remain development goals.

## Why Atlas matters

The expensive part of building a business is often the coordination: connecting
an idea to developers, websites, tools, deployment and daily operations. Atlas
aims to bring that work into one continuous mission:

**Goal → create → verify → launch → operate → improve.**

Its investment thesis is to become the execution layer between an idea and an
operating business. The opportunity extends from building software to operating
it, automating recurring work and expanding the capabilities available to the
next mission. The product combines customer-owned compute and credentials,
persistent agents, verifiable results and policy-controlled autonomy.

## What Atlas can do today

| Capability | Implemented scope |
| --- | --- |
| **Create websites and apps** | Project Genesis plans and builds business websites, CRUD apps, dashboards and REST APIs from supported templates, with coder-driven extensions and change requests. |
| **Build functional backends** | Generated local apps include sign-in/sessions, storage, per-app secrets, scheduled jobs and a durable background queue. |
| **Verify and repair** | Run project checks, attempt bounded repairs, open live previews, inspect desktop/phone layouts and critical workflows, and optionally use a vision model for review. |
| **Launch through integrations** | Approval-bound Git repository publishing/creation and static website deployment to Vercel. Server-backed app hosting remains additional work. |
| **Establish SEO foundations** | Website titles, descriptions, canonical links, sitemap and robots output. Continuous SEO/GEO measurement and optimization are planned. |
| **Engineer existing software** | Inspect repositories, make edits, compare baseline and post-change checks, repair regressions and deliver branches, patches or GitHub pull requests. |
| **Run parallel agents** | Missions, isolated coder lanes, competing versions and a Command Center with controls and execution traces. |
| **Keep working over time** | Durable sessions, scheduled/webhook/GitHub/file-change automations and bounded goals that sleep and wake on events. |
| **Operate computers remotely** | Paired Windows browser/computer execution, local desktop drivers, approvals and revocable phone access over customer-managed HTTPS/VPN. |
| **Own the intelligence** | Local Ollama-compatible models, hardware/context fitting and optional hosted providers, with budgets, routing and provider diagnostics. |

See [the reconciled todo list](TODO.md) for evidence and remaining work,
[Genesis](docs/atlas-os/GENESIS.md) for app-builder boundaries, and
[sovereign mode](SOVEREIGN-MODE.md) for local ownership and remote access.

## Child agents and advanced orchestration

Atlas's most advanced capabilities connect creation to persistent execution:

- **Child agents and specialist teams:** mission children and agent families
  divide work into scoped tasks, with roles spanning engineering, design,
  research, computer operations and review. Parallel coder lanes work in
  isolated worktrees and return evidence for comparison.
- **Command Center:** see mission and lane status, execution traces, competing
  versions and pause/resume/cancel controls.
- **Shared agent kernel:** chat, team steps, coder lanes and Genesis builds use
  a common goal-driven execution abstraction with mounted capabilities and
  explicit world state.
- **World-state and repository impact graphs:** relate packages, files, imports
  and tests, then trace what a proposed change could affect.
- **Scoped memory and provenance:** retain bounded context and verified team
  outcomes, with records of where the evidence came from.
- **Capability economics:** choose local mission models using verified run
  history, estimated time, privacy and configured limits.
- **Adaptive autonomy:** assess action risk and tighten owner policy where
  needed; suggested policy changes require owner acceptance.
- **Persistent missions and sleeping goals:** retain progress and recovery
  state; bounded goals can wake on signed GitHub events.
- **Durable automations:** schedules, webhooks, GitHub events and file changes
  start normal missions with history, duplicate guards and failure handling.
- **Verified software creation:** generated backend modules, baseline-aware
  checks, bounded repairs, responsive browser inspection and optional vision
  review help turn an idea into a working product.
- **Remote browser and computer control:** paired Windows execution and
  revocable phone access connect software work to the customer's machine.
- **Provider-neutral intelligence and MCP:** local model hosting, optional
  hosted providers, inference quota controls and scoped connector tools.
- **Guarded self-improvement and innovation:** isolated changes, checks,
  independent review and an opportunity-to-decision pipeline support controlled
  expansion of Atlas's capabilities.

These are implemented slices across the local and hosted products, with scope
and remaining integration work recorded in [TODO](TODO.md) and
[ROADMAP](docs/ROADMAP.md). The standalone child-agent registry, broader
organization graph, adversarial-review tiers and end-to-end skill installation
loop still require integration; they are not all enabled in every surface.

## Four pillars

| Pillar | What it means |
| --- | --- |
| **Create** | Build repositories, websites, apps and APIs; expand into games and other digital products. |
| **Execute** | Coordinate agents that write code, run checks, repair failures and operate computers. |
| **Operate** | Carry work through persistent missions, remote control and recurring automations. |
| **Grow** | Connect product iteration, business workflows, SEO/GEO and reusable capabilities to measured outcomes. |

## Autonomy that can grow

Atlas's agent kernel connects goals, capabilities, environments, policy, budgets,
memory and explicit world state. Initial slices include repository impact maps,
risk-based autonomy, event-driven goals and local model selection informed by
verified run history.

The next capability loop is to identify missing functionality, build a tool or
skill, independently verify it, obtain installation approval and make it
available to future missions. Parts exist today; the complete automatic loop
is still being connected. Self-improvement currently uses bounded changes,
checks and independent review, with an explicit delivery/merge policy.

## From software launch to business growth

The business roadmap joins product requirements, websites, full apps, approved
deployment, lead capture, operational integrations and analytics in a shared
mission. Ongoing SEO work will add crawl/indexability audits, structured data,
performance monitoring and content refresh. GEO will extend this toward
evidence-backed content and measured visibility in generative search systems.

These are development objectives. Atlas does not yet demonstrate unattended
operation of arbitrary businesses, guaranteed search rankings or guaranteed
revenue. Growth claims will be grounded in repeatable customer outcomes.

## Advanced research

The founder has identified quantum physics as an additional research direction.
This public-main audit did not locate the underlying quantum/physics work.
Its implementation status, experiments and results need to be reconciled before
Atlas can claim a quantum capability or performance advantage. The current
agent architecture runs on conventional software and model infrastructure.

## Start locally

Install Node.js, Git and a compatible model runtime. Individual packages declare
their required Node versions; Genesis uses Node's built-in SQLite support.

```powershell
# From the repository root, start the local control plane
Set-Location .\apps\local-control
npm start
```

Follow [sovereign mode](SOVEREIGN-MODE.md) for setup, local identity, model
configuration, device pairing and remote access. For direct coding:

```powershell
node scripts/local/run-coder.mjs --repository C:\path\to\project --objective "Fix the failing test and verify the result"
```

The [CLI guide](packages/atlas-cli/README.md) covers installation, inspection and
coding commands. Hosted setup and production checks are documented in
[HOSTED-VERIFICATION](docs/HOSTED-VERIFICATION.md).

## Architecture and delivery status

- [Local control](apps/local-control): durable agent runtime, Genesis,
  missions, automations, model hosting and local UI.
- [Coder CLI](packages/atlas-cli): TypeScript repository intelligence,
  editing, validation and repair.
- [Web workspace](apps/web): hosted chat, task intake, repository connections,
  setup and approvals.
- [Windows companion](apps/windows-companion) and
  [browser worker](apps/browser-worker): computer/browser execution surfaces.
- [Inference](packages/atlas-inference) and
  [contracts](packages/atlas-contracts): shared reliability and domain contracts.

Source capabilities, passing CI, a deployed service and an updated customer
installation are separate evidence levels. Some executor/credential boundaries,
tool-level recovery, visual editing, native mobile delivery and production
provider setup remain unfinished. The root Python agent is a legacy prototype;
current product work lives in the packages and apps above.

[Product roadmap](docs/ROADMAP.md) · [Current todo](TODO.md) ·
[Release evidence](docs/PROGRESS.md) ·
[Issues](https://github.com/cornerstonemarketingus/atlas/issues)

**Suggested GitHub About description:**
Autonomous software platform for repositories, websites and apps, with child
agents, computer control and persistent automation. From idea to operation:
building toward games, complete business creation, SEO/GEO growth and reusable
capabilities.
