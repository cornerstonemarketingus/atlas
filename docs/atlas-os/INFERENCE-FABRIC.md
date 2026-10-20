# Inference fabric: free, owned and rented models behind one router

Status: design (2026-10-19), building in phases A–D below. Owner question
that started it: "besides Groq, can we use our own cloud or other free
options?" Live evidence the same day: Groq's free tier refused requests over
its 8,000-token-per-minute allowance, Workers AI had spent its free daily
allocation (code 4006), and OpenAI had no credits (verify-hosted run
39105457659). One vendor running dry stopped all of Atlas.

## Principles

1. **Owned compute first.** The only capacity that cannot be withdrawn,
   repriced or used for training is hardware the owner controls. Free vendor
   tiers are overflow, never the foundation: in 2026 alone GitHub Models was
   retired (30 July), Cerebras became a card-only trial, Gemini's free tier
   lost Pro models, and Oracle halved Always Free Arm capacity.
2. **Every source declares who may see the data.** The router enforces it;
   no caller can opt a repository into a provider that trains on it.
3. **Schedule, don't fail** (CLAUDE.md: never reduce capability to fit a
   provider). When every source is exhausted, work waits for the next reset
   or for owned compute to come online, and says when.
4. **One contract.** Every source speaks OpenAI chat completions; differences
   (limits, context, tools, trust, cost) are data in a catalog, not code paths.

## Trust tiers

| Tier | Meaning | May receive |
|---|---|---|
| `private` | Owner's hardware or owner's cloud account (home PC, Modal, Oracle, rented GPU through the compute plane) | Everything, including repository code |
| `vendor` | Paid or no-training API terms (Groq, Workers AI, Cerebras, paid OpenAI, Anthropic) | Everything |
| `trains` | Free tiers whose terms allow using prompts to improve products (Gemini free, OpenRouter `:free` routes, Mistral free) | In chat, only requests made of Atlas's own system prompt (registered where it is built) and messages the person typed: no tool output, no workspace memory, no other system context and no earlier Atlas replies (they can quote files). Decided by recorded provenance, not by inspecting text, so anything the person types, pasted code included, does reach the provider; that is what `ATLAS_ALLOW_TRAINING_PROVIDERS=1` consents to. The coder uses them only with `=all`, which consents to sending repository code. |

An owner on a paid plan of a `trains` vendor sets `ATLAS_<VENDOR>_TIER=paid`
to move it to `vendor`.

## Sources (researched 2026-10-19; free terms change without notice)

| Source | Cost | Capacity | Tier | Role |
|---|---|---|---|---|
| Home PC + `scripts/local/model-gateway.mjs` + Cloudflare Tunnel | $0 (power) | Unlimited while on; ~60–90 tok/s 7B, a 24 GB card runs 27–30B coders at Q4 | private | Primary coder |
| Modal serverless GPU (vLLM, scales to zero) | $30/month free credits | Bursts; cold start ~1–2 min | private | Coder when the PC is off |
| Rented GPU via compute plane (Vast.ai/RunPod) | ~$0.15–0.75/h for an RTX 4090 | Hours, budget-capped by `TaskBudget` | private | Long autonomous runs |
| Oracle Always Free A1 | $0 | 2 OCPU / 12 GB Arm since 2026-06-15; ~8–12 tok/s on a 7B Q4 | private | Always-on small model, gateway relay |
| Groq | free tier | 8k TPM per gpt-oss model, daily caps | vendor | Interactive chat |
| Workers AI | 10k neurons/day free | Daily | vendor | Interactive chat |
| Cerebras | $5 trial (card) | ~1M tok/day while it lasts | vendor | Fast overflow |
| Gemini (AI Studio) | free tier, Flash only | Per-project RPM/RPD, reported 20–1,500/day | trains | Chat overflow |
| OpenRouter `:free` | free | 20 RPM, 50/day (1,000/day after $10 once) | trains | Chat overflow |
| Mistral | ~$10/month credits | Console-defined | trains | Chat overflow |
| Kaggle / Colab | free notebooks | — | — | Not usable: sessions, not servers; terms exclude serving |

Model choice for owned compute (24 GB card or 32 GB+ unified memory):
Qwen 27B-class dense coder or Qwen3-Coder 30B-A3B (MoE, long context) at Q4,
Devstral Small for 16 GB, gpt-oss-20b as the tool-calling generalist. Context
must be configured to at least 32k (Ollama's default is smaller). The Models
page's hardware detection (`agent/models/hardware.mjs`) picks among them.

Buying hardware, roughly: a used RTX 3090 (24 GB, ~$700–1,000) is the most
model per dollar for ≤30B; Apple Silicon with 64 GB holds 70B at ~8–18 tok/s.
At ~$0.35/h, 2,000+ hours of rented 4090 cost the same as a 3090, so renting
wins for occasional use and owning wins for daily autonomous work.

## Routing

Work classes, each with an ordered preference that skips sources whose tier,
context or tool support does not fit (the existing `incompatibility` check):

- **interactive** (chat reply): fastest available — Groq → Workers AI →
  Cerebras → owned → `trains` (if allowed and the request qualifies) → OpenAI.
- **coder** (repository tools, many turns): owned PC → Modal → Cerebras →
  Groq → Workers AI → OpenAI/Anthropic. `trains` only with the owner's `all` consent.
- **background** (self-improvement, evals): owned compute when idle, else the
  unspent daily allowance; deferred rather than refused.

Each source is described once in `packages/atlas-inference/src/catalog.mjs`
(id, origin, key variable, default models, tier, capabilities) and read by
the hosted chat, the coder runner and the local daemon.

## Capacity, not failure

- The quota ledger already learns per-minute allowances and fits requests to
  them (#382). It also records daily refusals (`scope: "daily"`).
- A coder run whose every route is out of capacity waits, inside the run,
  for the soonest stated reset and carries on with its work intact
  (`FallbackModelProvider`, `--capacity-wait-ms`, repository variable
  `ATLAS_CODER_CAPACITY_WAIT_MS`, default 5 minutes for the whole run; the
  runner bounds the coder at 15). A reset beyond that, such as a daily quota,
  ends the run at once with when the soonest reset is. Re-dispatching such a
  task later from hosted Atlas is deferred: a task has exactly one claimed
  cloud run (execution claims), so a resume needs a new claim generation.
- The home PC's gateway is probed on `/v1/models`; when it answers, coder
  work prefers it, and waiting tasks resume immediately.

## Owner setup: no card, little disk (2026-10-19)

The owner's machine has no room for local models and no card is wanted, so
owned compute (home PC, Modal, Oracle, Cerebras's trial, rented GPUs) stays
optional and nothing below needs it. Resilience comes from breadth: each
free, no-card vendor is one more place a refused request bounces to.

1. Create free API keys (no card): Groq (console.groq.com), Google AI
   Studio for Gemini (aistudio.google.com), OpenRouter (openrouter.ai),
   Mistral (console.mistral.ai, phone verification). Cerebras needs a card.
2. Add each as a repository secret: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
   `MISTRAL_API_KEY` (and `CEREBRAS_API_KEY` if ever wanted). Run "Deploy
   Atlas web to Cloudflare Workers" so chat sees them.
3. Allow the training tiers, knowing what each setting sends:
   - secret `ATLAS_ALLOW_TRAINING_PROVIDERS=1` (chat): a training tier is
     used only for a request made of Atlas's own system prompt and what
     you typed, typically the first message of a conversation. Whatever you
     type, pasted code included, may then be used by that vendor. Tool
     output, workspace memory, other system context and earlier replies
     never go to it.
   - repository variable `ATLAS_ALLOW_TRAINING_PROVIDERS=all` (coder):
     sends repository code and objectives. Reasonable for a public
     repository such as Atlas, whose code is already public.

Any refusal now moves on: rate limits, daily quotas, no credit, a model
that is gone, a request too large, or a rejected key (still logged). Only
a malformed request stops, because every provider would refuse it.

## Phases

- **A — more sources, enforced trust, waiting instead of failing.** Catalog;
  Gemini, OpenRouter, Mistral, Cerebras in chat and coder; trust enforcement;
  every refusal routes on; the coder waits out short resets in-run (built).
  Hosted re-dispatch after long resets is deferred (see Capacity).
Phases B–D are optional for this owner (no disk, no card) and wait until wanted.

- **B — the home PC as primary.** One command connects the PC (gateway +
  tunnel + model check) and registers it as the hosted `private` source;
  health probe; coder preference.
- **C — Modal.** `infra/modal/` deploys vLLM with a chosen open model,
  scale-to-zero, bearer-protected; registered as a `private` source.
- **D — Oracle Always Free.** `infra/oracle/cloud-init.yaml` installs Ollama
  (arm64), a small model, the gateway and a tunnel.
- **Later:** a real compute-plane adapter (Vast.ai or RunPod) once the owner
  picks a provider and a monthly cap; nothing spends money before that.
