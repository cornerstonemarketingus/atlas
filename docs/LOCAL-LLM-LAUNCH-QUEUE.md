# Key-free local Atlas launch queue

Updated 2026-10-21. This is the immediate queue for the owner's Windows PC;
the broader roadmap remains in OPERATOR-QUALITY-ROADMAP.md. Checked items
have the evidence stated here, not a claim of Claude Code feature parity.

## Completed on this PC

- [x] Inspect hardware: about 8 GB RAM, Intel UHD integrated graphics, CPU inference.
- [x] Clear npm download cache before launch work: free disk rose from about
  44.4 GiB to 46.8 GiB. Later free space was about 39.7 GiB; system activity
  changed it. No project, model, user document or existing worktree was deleted.
- [x] Preserve the dirty owner checkout; use a managed checkout of main cdfcc83
  at `C:\Users\jmhl3\.codex\worktrees\local-llm-launch\atlas`.
- [x] Repair Windows launch model propagation and choose a smaller installed
  model automatically below 14 GiB total memory. Explicit selections win.
- [x] Load installed choices into conversation model picker and default new
  chat to the streaming conversation executor. Preserve later user choices.
- [x] Start Atlas on loopback port 4317 using installed `qwen3:1.7b` and Ollama
  on 11434. Owner identity uses the existing Windows DPAPI vault. No provider
  key was provisioned; no tunnel or public listener was created.
- [x] Complete a real local conversation: session
  `b705cb86-a666-4c32-8623-bc004669866c`, completed, 170 input tokens, seven
  output tokens, zero tool calls and zero recorded provider cost. It took
  254,570 ms under load. This is chat wiring evidence, not a coding benchmark.
- [x] Run a bounded direct Ollama 0.6B comparison: `qwen3:0.6b`, 2,048-token
  context, thinking off, returned `READY.` in 41,318 ms, including 32,668 ms
  loading. This smaller model is also slow cold; warm agent performance and
  coding quality remain unqualified. The comparison unloaded its model after use.
- [x] Add Start Menu entry **Atlas Local - Key Free**, using the checkout above
  and data directory `C:\Users\jmhl3\.atlas-local-launch`. It starts on demand;
  automatic sign-in startup has not been enabled. Keep this checkout while the
  shortcut points to it.
- [x] Run affected HTTP, session UI and initial launch tests: 16/16 pass.
  Final five launcher/UI tests pass in isolation, including automatic small-model
  choice and reopening an existing daemon. A concurrent expanded run hit two
  20-second PowerShell subprocess timeouts; isolated tests passed without
  raising those deadlines. No full-suite or reliable under-load success is claimed.
- [x] Triage all 37 currently open PRs by descriptions and file inventories;
  inspect the five most relevant patches. See OPEN-PR-LAUNCH-TRIAGE-2026-10-21.md.

## P0 — local chat performance and recovery

- [ ] Compare installed 0.6B, 1.7B and existing bounded-context model variants
  sequentially with one model resident. Record cold/warm first-token latency,
  total latency, actual context, RAM and disk/pagefile impact. Do not download
  larger weights or increase parallel agents on this 8 GB PC to hide failures.
- [ ] Reconcile #230's measured local setup and memory/context checks with
  current main and this launch fix. Keep its supervisor launch path. Verify
  an honest unavailable state when RAM is insufficient, with paid fallback off.
- [ ] Verify owner-token startup/reopen under load: this session observed an
  opener creating a new vault token after daemon startup; the old daemon then
  rejected the new token. Restarting our daemon restored authenticated access.
  Investigate read failure versus absence before changing credential logic.
  Never bypass authentication to make a health check pass.
- [ ] Retry clean installed-payload acceptance with resource observations.
  This run failed source-installer subprocess timeout and MSI staged-daemon
  startup timeout. Cause is not established; don't weaken assertions/timeouts
  or describe a source-checkout launch as signed-installer acceptance.

## P1 — coding usefulness, then release

- [ ] Reconcile #230 with #200 and packaged compiled CLI. Run a real disposable
  repository task: inspect files, edit a defect, run a failing test, repair it,
  return a reviewable diff, and prove paid fallback stays disabled. A hello
  response, generated code paragraph, or scripted fake model is insufficient.
- [ ] Run tool-call, structured-output, cancellation, restart and approval
  refusal probes against the actual selected model. Route only qualified
  capabilities to it. Label small models as limited until these pass.
- [ ] Reconcile #240/#178 and #414/#417 only with fresh CI and required review.
  Hosted pools are optional and do not remove provider-key requirements.
- [ ] Reconcile recovery, ownership, credential and takeover branches using
  the triage report; preserve exact-action approvals, scoped identities,
  budgets, redaction and evidence checks. Do not mass-merge stale branches.
- [ ] Complete signed installer and packaged coder acceptance before enabling
  automatic Windows startup or replacing an existing installation.

## P1 — UI acceptance

- [ ] Inspect desktop and phone-width layouts in a connected browser. Browser
  automation could not attach during this session; no screenshot QA is claimed.
- [ ] Put model name, local/hosted execution, capacity state and measured
  speed where the user sends a message; expose Stop and recoverable failures.
- [ ] Verify streaming, retained transcript, conversation switching, model
  choice and executor choice together against actual local inference.
- [ ] Reuse #181 for verified preview editing; qualify its source mapping and
  undo before expanding to layout/component changes.

## P2 — optional cloud capacity and research

- [ ] Decide on paid capacity only after local benchmarks. No subscription
  purchase or billable resource launch has been performed.
- [ ] Keep quantum #429 and federated compute #423 behind the usable-chat and
  coding gates; neither is needed for a local model launch.

## Cost decision

Local Ollama with installed open weights needs **$0/month in provider
subscriptions** (electricity and hardware costs still apply). On this 8 GB
CPU-only PC, that does not establish strong coding-agent efficacy.

Cloudflare Workers Paid starts at **$5/month**, with separately metered AI
usage beyond applicable included allowances. Workers AI can use a Worker
binding, avoiding OpenAI/Anthropic keys, but still requires a Cloudflare account,
deployment and applicable billing. This is an optional low-base-cost hosted
candidate, not a measured quality-equivalent recommendation.

For owned open-model inference on rented GPUs, RunPod lists an A40 48 GB at
**$0.59/hour** in the inspected pricing view. Ten running hours is $5.90 before
storage/other charges; 730 running hours is $430.70. Model fit, licence,
availability, trust boundary and task quality must be checked before renting.
It uses a compute-provider account/credential, even though model-vendor keys
are unnecessary. No provider is proven globally cheapest by this limited survey.

Sources checked 2026-10-20/21:
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://www.runpod.io/pricing

## Reopen this PC's instance

Use **Atlas Local - Key Free** in Start Menu. The launcher opens an existing
healthy daemon instead of starting a second copy. Direct URL:
`http://127.0.0.1:4317`; use the opener for automatic owner sign-in.
Data and daemon logs: `C:\Users\jmhl3\.atlas-local-launch`.
The listener is local to this PC; hosted Atlas cannot reach it without a
separately authorized connection. Keep that boundary private by default.
