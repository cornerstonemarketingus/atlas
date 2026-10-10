# Atlas — Build it. Run it. Grow it.

**An autonomous operating system for building software and scaling digital work.**

Atlas brings app creation, software engineering, computer control and persistent
automation into one workspace. Give it a goal: it can plan the work, build and
test supported websites and applications, inspect the result in a browser,
coordinate parallel agents and publish through approved integrations.

The ambition is larger: **turn an idea into a complete business, then keep
improving its software, operations and discoverability.** Atlas is building
toward a continuous launch-and-growth workflow spanning websites, full
applications, SEO, generative engine optimization (GEO), customer workflows and
recurring operations. The software-building foundations are implemented;
complete business operation and continuous SEO/GEO growth remain roadmap work.

## Why it matters

Businesses repeatedly pay the coordination cost between ideas, developers,
websites, marketing tools and day-to-day operations. Atlas aims to compress that
cycle in one persistent system: **goal → build → verify → launch → operate →
improve**. A successful workflow can become an automation; verified outcomes
can inform future model choices; approved software improvements can expand what
Atlas can do next.

The investment thesis is a platform for repeatable digital execution, with
expansion from software creation into ongoing business operations. Its
differentiation rests on customer-owned compute and credentials, a shared agent
runtime, evidence-backed verification and policy-controlled autonomy. Commercial
advantage and business-growth outcomes still require measured validation.

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
Autonomous AI operating system for building websites and apps, operating computers,
and automating digital work. Local-first agents with remote control and verified
execution; building toward complete business launch, continuous SEO/GEO growth,
and reusable capabilities.
