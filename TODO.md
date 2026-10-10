# Atlas — accomplished work and remaining roadmap

Reviewed: 2026-10-09. Scope: public `main` at `17570ff348baef91a7637153df93538d56629762`.

This list reconciles the former backlog with current source, test coverage,
merged pull requests and recorded release evidence. A checked item means the
specific slice described is present on main; it does not certify every
deployment, installed companion, business outcome or broader milestone.
No fresh local tests or live production checks were run for this documentation
audit: local terminal startup was unavailable.

The previous full wishlist is preserved in
[TODO-LEGACY-2026-09-26.md](docs/TODO-LEGACY-2026-09-26.md) for traceability.
Its checkboxes and assignments are historical, not current status.
[PROGRAM](docs/PROGRAM.md) governs execution and merge policy;
[ROADMAP](docs/ROADMAP.md) sets product sequencing;
[PROGRESS](docs/PROGRESS.md) records releases. Follow those documents when
selecting implementation work. Older CURRENT-STATE/BACKLOG snapshots retain
their original audit dates.

## Product objective

Build a local-first autonomous operating system for digital work: take a
business or product goal, assemble agents and tools, create websites and apps,
verify the result, publish through approved integrations, and turn recurring
work into durable automations. Extend this foundation into complete business
launch and growth workflows with ongoing SEO and generative engine
optimization (GEO), measurable acquisition and operational feedback.

## Accomplished on main

### Repository intelligence and verified coding

- [x] Strict TypeScript CLI with bounded, ignore-aware inspection, tree,
  search, contextual reads, heuristic symbols and references.
- [x] Repository command discovery plus package/import/environment/schema,
  delivery and security-surface intelligence slices.
- [x] Provider-neutral model contracts, compatible local/hosted inference,
  runtime validation, policy-enforced tools, budgets and audit records.
- [x] Coder workflow: capture baseline, edit, run project checks, compare
  results, attempt bounded repairs and return verification evidence.
- [x] File editing improvements: permission bits and UTF-8 BOM preservation,
  changed-hunk previews and confirmation for generated/vendor/lockfile edits.
- [x] Process-tree termination and bounded command output; session undo
  without rewriting Git history.
- [x] Hosted task dispatch, GitHub App integration, branch/PR delivery and
  CI-gated merge/steward machinery. Local patches and worktrees provide an
  alternative delivery path.

Evidence: [CLI](packages/atlas-cli/README.md),
[release log](docs/PROGRESS.md), merged
[#151](https://github.com/cornerstonemarketingus/atlas/pull/151),
[#154](https://github.com/cornerstonemarketingus/atlas/pull/154),
[#162](https://github.com/cornerstonemarketingus/atlas/pull/162),
[#163](https://github.com/cornerstonemarketingus/atlas/pull/163).

### Project Genesis — websites and applications

- [x] Prompt-to-specification and bounded dependency-ordered planning,
  durable lifecycle, local Git workspace and conversational change requests.
- [x] Website, web-app/dashboard/CRUD and REST API templates.
- [x] Business website pages, enquiry flow and SEO foundations: titles,
  descriptions, canonical links, sitemap and robots file.
- [x] Generated-app backend modules: password sign-in/sessions, file storage,
  per-app secrets, scheduled jobs and durable background queue.
- [x] Execute build/test/check stages, repair failures, start a healthy
  preview, inspect at desktop and phone widths and record evidence.
- [x] Chromium workflow checks and optional model-based visual review/polish.
  HTTP-only inspection is explicitly marked limited.
- [x] Local Build UI and Genesis chat tools with pause/resume/cancel/retry
  and a verified-result summary.
- [x] Approval-bound repository creation/publishing adapters for
  GitHub/GitLab/Forgejo and static website deployment to Vercel.
  Server-backed apps/APIs are refused by the static deployment path.
- [x] Repeatable creation benchmarks and real coder/browser CI scenarios.

Evidence: [Genesis behavior, limits and benchmark baseline](docs/atlas-os/GENESIS.md),
[static site renderer](apps/local-control/src/platform/genesis/templates/static-site/files/scripts/build.mjs),
[#175](https://github.com/cornerstonemarketingus/atlas/pull/175),
[#209](https://github.com/cornerstonemarketingus/atlas/pull/209),
[#211](https://github.com/cornerstonemarketingus/atlas/pull/211).
The documented original no-model baseline was 4/5 scenarios ready;
the authenticated scenario then required a configured coding model. This
historical fixture result is not a general autonomous app success rate.

### Persistent agents, parallel work and automations

- [x] Local SQLite task/session state, leases, event streams, outbox,
  audit timeline and interruption handling.
- [x] Parallel coder missions and team missions, isolated lanes, comparison,
  recommendation and approval-bound application of a chosen version.
- [x] Command Center view with individual lane controls and kernel traces.
- [x] Shared kernel/world-state first slice across chat, team steps,
  coder lanes and Genesis; mounted capabilities and launch-time branching.
- [x] Repository world graph and evidence-linked impact traversal.
- [x] Capability economics first slice: local model selection informed by
  verified run history, estimated time, privacy and configured limits.
- [x] Adaptive autonomy first slice: action risk assessment tightens owner
  policy; dangerous actions ask or are prohibited. Policy relaxation remains
  a suggestion requiring owner acceptance.
- [x] Durable automations with schedule, webhook, GitHub-event, file-change
  and run-now triggers; history, duplicate/overlap guards and failure pause.
- [x] Sleeping goals wake on signed GitHub deliveries, bounded by expiry
  and wake count.
- [x] Mission recovery retains provider cooldown, reduced concurrency,
  retry/backoff state, completed child evidence and spent budgets.
  Restart still requires explicit operator resume.

Evidence: [roadmap and implemented Track B slices](docs/ROADMAP.md),
[#169](https://github.com/cornerstonemarketingus/atlas/pull/169),
[#171](https://github.com/cornerstonemarketingus/atlas/pull/171),
[#212](https://github.com/cornerstonemarketingus/atlas/pull/212),
[#213](https://github.com/cornerstonemarketingus/atlas/pull/213),
[#214](https://github.com/cornerstonemarketingus/atlas/pull/214),
[#215](https://github.com/cornerstonemarketingus/atlas/pull/215),
[#225](https://github.com/cornerstonemarketingus/atlas/pull/225),
[#226](https://github.com/cornerstonemarketingus/atlas/pull/226).

### Remote access, computer control and local ownership

- [x] Paired Windows companion for browser/computer tasks, action policy,
  consequential-action approvals and local credentials.
- [x] Local desktop control drivers and a browser-worker package with
  disposable sessions and guarded network access.
- [x] Owner identity backed by the OS account/keychain with a documented
  fallback; local operation does not require GitHub OAuth.
- [x] Expiring phone pairing codes and separately revocable device tokens.
- [x] Guided customer-managed HTTPS/VPN remote access; loopback by default.
- [x] Encrypted backup/export/import, audit browsing and local policy UI.
- [x] Ollama model discovery, hardware/context fitting, recommended
  coder/reviewer/fast plan and install/run/remove controls.
- [x] Windows launch/package tooling, checksum/signing support and offline
  license verification. Available tooling does not establish that a
  particular production installer has been signed and released.
- [x] Guarded local self-improvement with checks, independent review,
  bounded changes and branch/patch delivery.
- [x] MCP client integration and scoped memory foundations; broader gateway,
  marketplace and memory-management UX remain incomplete.

Evidence: [sovereign mode](SOVEREIGN-MODE.md),
[browser worker](apps/browser-worker/README.md),
[operator roadmap](docs/OPERATOR-QUALITY-ROADMAP.md).
Browser-worker availability does not mean it is the daemon's default browser.

### Hosted inference reliability

- [x] Shared inference contracts/ledger, quota admission, circuit breakers,
  capability/context checks, bounded attempts and fallback control on main.
- [x] Cloudflare Workers AI, self-hosted compatible endpoints, Groq and
  OpenAI routing; selected models and the serving provider are visible.
- [x] Provider credential diagnostics without exposing credentials.
- [x] Replies remain visible when persistence fails; rejected post-tool
  transcripts use bounded final synthesis for recoverable 400/422 failures.

Evidence: [#224](https://github.com/cornerstonemarketingus/atlas/pull/224),
[#228](https://github.com/cornerstonemarketingus/atlas/pull/228),
[#229](https://github.com/cornerstonemarketingus/atlas/pull/229),
[#232](https://github.com/cornerstonemarketingus/atlas/pull/232),
[#239](https://github.com/cornerstonemarketingus/atlas/pull/239),
[#241](https://github.com/cornerstonemarketingus/atlas/pull/241).
The last PR reports 437 passing web tests in CI. That is recorded CI
evidence, not a new local run or proof of healthy production credentials.

## Remaining work and acceptance gates

### Reliability and execution boundaries

- [ ] Finish credential/approval enforcement at every actual tool boundary:
  reject stale/wrong-principal/context approvals, prevent privilege inflation,
  keep credentials out of model/tool outputs, and prevent execution after
  cancellation. Reconcile existing work before adding another executor.
- [ ] Unify authorized execution, persistent budget accounting and idempotency
  across conversation, platform, terminal and desktop paths.
- [ ] Continue an interrupted tool-level session without replaying completed
  consequential actions; test crashes before and after external effects.
- [ ] Connect the runner-side coder to shared inference capacity through an
  authenticated governor path; the Worker ledger does not currently govern
  all CLI inference.
- [ ] Verify configured providers against the deployed streaming and JSON
  chat routes; resolve credential/billing/capacity failures with live evidence.
- [ ] Finish side-effect-free replay, versioned eval/release gates and
  measured quality/cost/recovery scorecards. Open implementations are not
  treated as shipped.
- [ ] Finish hosted rate limiting, audit coverage, billing-cap concurrency,
  tenant/member UX and accessibility; verify migrations and account settings
  against production before marking them done.

### App creation, deployment and operator experience

- [ ] Finish visual element-to-source editing and competing versions evaluated
  on tests, security and browser behavior.
- [ ] Deploy server-backed apps/APIs with databases, migrations, secrets,
  health checks, backups and rollback. Static-site deployment is narrower.
- [ ] Deliver a persistent cloud sandbox and safe Local/Cloud/Hybrid task
  migration so work continues when the customer's computer is off.
- [ ] Finish live observation, pause/takeover/hand-back and crash-safe action
  receipts across browser and desktop; reconcile the open operator work.
- [ ] Wire the browser worker as the default daemon browser where intended.
- [ ] Validate signed Windows installation/update/rollback/uninstall in a
  clean VM; complete native mobile signing, secure storage, biometric gates
  and physical-device tests.

### Complete business launch and growth

- [ ] Join opportunity research, business requirements, branding, websites,
  apps and deployment into one durable business-launch mission.
- [ ] Deliver ongoing SEO maintenance: crawl/indexability checks, absolute
  production canonicals/sitemaps, structured data, performance monitoring,
  content refresh and measured search outcomes.
- [ ] Deliver GEO: evidence-backed, crawlable content for AI discovery,
  entity consistency, citations and measured visibility across selected
  generative search systems. Existing SEO tags do not establish GEO.
- [ ] Connect consent-aware lead capture, CRM, analytics, conversion tests,
  payments and operational integrations under explicit policies and budgets.
- [ ] Demonstrate repeatable end-to-end launch and growth outcomes with
  intervention rate, cost, uptime and customer evidence. Website/app fixtures
  do not establish that Atlas can autonomously operate a complete business.

### Capability growth and advanced research

- [ ] Complete the capability loop: detect a gap, build a skill, independently
  test/review it, approve its digest, install it and record provenance.
- [ ] Wire signed skills/MCP gateway and extend organization knowledge graphs,
  independent QA/security agents and routing beyond local-model history.
- [ ] Expand compiler-backed language intelligence and incremental indexing.
- [ ] Complete enterprise governance, stable SDKs, commercial metering and
  general document/spreadsheet/presentation creation where roadmap requires.
- [ ] Reconcile the founder-identified quantum physics research with its
  actual branch/files, hypotheses, experiments and reproducible results.
  No quantum/physics implementation or validated advantage was found in this
  audit of public main; research is not a shipped product capability.

## Completion standard

A future checkmark must name its exact scope and link code, boundary tests,
required CI and relevant live evidence. Include model/provider requirements,
remaining limitations and measured outcomes. A merged interface, open PR,
historical branch checkbox or successful deployment alone is insufficient.
