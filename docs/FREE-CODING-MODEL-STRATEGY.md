# Coding on proprietary software without outside keys

Question: how can users code "endlessly" on Atlas's own proprietary software for free, with no outside API keys?

Short answer: it is achievable for users who run the model on their own hardware, and for a pool Atlas runs on its own GPUs. It is not free for Atlas in the second case: compute is the cost, and a shared free pool cannot be endless. Plan for three tiers and measure before claiming any of them is "strong".

## What already exists (audit, not aspiration)

| Piece | State |
|---|---|
| Local daemon with an Ollama adapter, local executor, Git-worktree runner, measured model capability registry | Implemented (`apps/local-control`) |
| `ATLAS_CODER_BASE_URL` points the coder at any OpenAI-compatible server (vLLM, Ollama, llama.cpp, TGI, a rented GPU) | Implemented; the endpoint must be https unless loopback |
| Actions runner starts Ollama on the runner (`ATLAS_SELF_HOSTED_MODEL`) | Implemented; CPU-only runners are an order of magnitude too slow for real coding, so it is a smoke path, not a product |
| Hosted chat on Workers AI through the Worker's own binding, no token | Implemented; free allowance is small and shared per Cloudflare account |
| Eval harness (35 validated tasks) to compare models | Implemented; no baseline pass rates yet (no provider key was available) |
| Guided local setup and measured coding qualification | Draft PR #230 (not merged) |
| "Atlas Node": native inference daemon on a local or GPU host, dialling out, no public exposure | Planned (PROGRAM Phase 4); not built |

## The three tiers

1. **User hardware (zero marginal cost, private by construction).** The local daemon runs an open-weight coding model on the user's machine. Proprietary code never leaves it. This is the only tier that is genuinely endless and free to everyone. Limit: model quality is capped by the user's GPU/RAM, so setup must measure what fits and what answers in time instead of assuming.
2. **Atlas-run GPU node (no keys, but not free to Atlas).** Run an open-weight model (for example gpt-oss-120b, a Qwen3-coder-class model) on rented or owned GPUs behind an OpenAI-compatible server (vLLM). Point `ATLAS_CODER_BASE_URL` and the chat endpoint at it. No third-party key, code stays in your infrastructure. The cost is GPU hours, so "free" needs per-user daily caps or a paid plan that covers it. Size it from measured tokens per task, not guesses.
3. **Workers AI free allowance (demo/chat only).** Good for chat and for the hosted website builder (which needs no model), not for sustained coding: the allowance is a small daily budget shared by everyone.

Optional escape hatch: `ATLAS_CODER_ESCALATION` can hand a repair the free model could not finish to a stronger paid model, only on failure. That spends a key only when the owner configures one.

## Making a free model strong (what actually moves results)

A weaker open model plus a strong harness beats a stronger model in a weak one. Atlas's levers, in order of payoff:

- **Verify before done.** Run the repository's own build and tests before and after every edit; repair introduced failures; never report success from the model's say-so (already how the coder works).
- **Small, concrete tasks.** One checkable change per run; discover tests and conventions first; bounded file ranges.
- **Context discipline.** Fit each request to the model's real window; read narrow ranges; summarise old results (the compaction and allowance-fit work is in `main`).
- **Eval-gated routing.** Choose models by measured pass rate on the eval suite for each task class, and re-run on every routing change. Do not publish "strong" without a baseline.
- **Cheap parallelism.** Best-of-n and independent review are affordable on a model you host; use them where the eval shows a gain.

## What not to do

- **Do not train a base model.** The cost is orders of magnitude beyond the benefit. If evals later show repeated failure classes on Atlas's own code, fine-tune a small adapter (LoRA) on its own history, behind the same eval gate.
- **Do not assume licences.** Check each model's licence for commercial use on proprietary software before shipping it (several families are Apache-2.0; some size variants are not).
- **Do not claim "unlimited".** Say what a tier costs and what its cap is.

## Recommended path

1. Merge the guided local setup (#230) so a user can install a measured, qualified local model in minutes; make local the default coder for the desktop app.
2. Stand up one GPU node serving an open-weight coder behind vLLM; wire it as the hosted default via `ATLAS_CODER_BASE_URL` (owner decision: provider, budget, per-user caps).
3. Run the eval suite against each candidate on that node and record baselines before any quality claim.
4. Keep escalation to a paid model off by default and opt-in per owner.

Owner decisions needed: GPU budget and provider, per-user free caps, which models pass the licence review.
