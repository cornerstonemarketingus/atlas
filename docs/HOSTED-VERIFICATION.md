# Hosted Atlas verification

The hosted workspace runs inspect, debug, and coder jobs through GitHub Actions.
Inspect reports repository structure; it does not yet generate an objective-specific
implementation plan. Coder proposes a pull request and records baseline/post-change
validation separately from the workflow conclusion.

## Results in the conversation

Both runner workflows have a separate reporting job. It reads bounded artifacts as
data, redacts their text using the trusted CLI, and posts findings to
`/api/tasks/result`. GitHub OIDC authenticates this call without a shared callback
secret. The Worker verifies the signature, audience, expiry, repository, main-branch
workflow, run attempt, and exact task identifier. The task's stored owner determines
the recipient. Stable event/message IDs and a D1 batch prevent duplicate results
on network retries. Existing tables suffice; this change needs no migration.

Repository execution jobs have no `id-token: write` permission. Keep reporting
isolated: never execute target repository code in a reporting job.

The Build conversation polls for delivered findings. A green workflow does not
imply a change, a pull request, or passing validation. Missing artifacts and failed
delivery are reported explicitly. Older runs have no callback and retain their logs.

## Hosted model configuration

Chat uses `ATLAS_CHAT_BASE_URL`, `ATLAS_CHAT_MODEL`, and `ATLAS_MODEL_API_KEY`.
For the exact Groq base URL `https://api.groq.com/openai/v1`, deployment can reuse
the existing `GROQ_API_KEY` when no separate model key is set. It never forwards
that fallback credential to another model host.

Optional repository secrets, uploaded to the Worker by the deploy:
`ATLAS_CHAT_FALLBACK_MODEL` (a second model on the same endpoint for when the
first is rate-limited; on Groq it defaults to `openai/gpt-oss-20b`, and `none`
turns it off), `ATLAS_TAVILY_API_KEY` (chat's web search), and
`ATLAS_ALLOWED_REPOSITORIES`. `GET /api/setup/status` reports under
`optional.chat` whether chat, its fallback model and web search are configured,
as flags only. `apps/web/tests/deploy-configuration.test.mjs` fails if chat reads
a variable the deploy does not upload.

A chat turn always ends in words. If the model's last response carried none (an
empty HTTP 200, a tool call on the final round, a reasoning model that spent its
budget thinking) or a rate limit interrupts work already done, one final
synthesis call writes the answer from the completed work, with tools disabled
and its own bounded retries. If no model can answer, the reply is the work
itself and says how to continue. Each such event is logged to the Worker as a
metadata-only `{"atlas":"inference",...}` line.

Coder uses its own repository variables. To use the existing hosted provider,
unset `ATLAS_SELF_HOSTED_MODEL`, select `ATLAS_CODER_PROVIDER=groq` and a supported
`ATLAS_CODER_MODEL`, and remove local-only context/output-window overrides.
The Atlas-only runner installs the target CLI's dependencies without lifecycle
scripts and verifies `packages/atlas-cli` by default.

### Your own model as the main chat model (Ollama)

Hosted chat can use a model on your own machine instead of Groq, with Groq and
OpenAI kept as fallbacks for when that machine is off, busy or too slow
(Automatic: your model → Groq `openai/gpt-oss-120b` → `openai/gpt-oss-20b` →
OpenAI). A Worker cannot reach your PC's localhost, so the model is reached
through `scripts/local/model-gateway.mjs` behind a public HTTPS address.

1. Install Ollama and pull a model that supports tool calling and fits your
   memory (for example `ollama pull qwen3:14b` with about 12 GB of GPU memory,
   `qwen3:8b` with less). A downloaded model is not proof it fits or answers in
   time: run one prompt with `ollama run` first.
2. Make a gateway token (32+ characters), e.g.
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
3. Start the gateway on the same machine (loopback port 11435):
   `ATLAS_MODEL_API_KEY=<token> ATLAS_GATEWAY_MODELS=qwen3:14b node scripts/local/model-gateway.mjs`
   (PowerShell: set `$env:ATLAS_MODEL_API_KEY` and `$env:ATLAS_GATEWAY_MODELS`
   first). It serves only `/v1/models` and `/v1/chat/completions`, streaming
   and tool calls included, behind the token; Ollama's management API is never
   exposed. Requests beyond `ATLAS_GATEWAY_CONCURRENCY` (default 1) wait in a
   short queue; a full queue answers 429, and Atlas moves to Groq.
4. Give the gateway a public HTTPS address: `tailscale funnel 11435` (a stable
   `https://<machine>.<tailnet>.ts.net` address, no domain needed), or a named
   Cloudflare Tunnel to `http://127.0.0.1:11435` on a domain you own. Never
   point a tunnel at Ollama's port 11434.
5. In the repository's Actions secrets set `ATLAS_CHAT_BASE_URL` to
   `https://<address>/v1`, `ATLAS_CHAT_MODEL` to the model name and
   `ATLAS_MODEL_API_KEY` to the token. Keep `GROQ_API_KEY` and `OPENAI_API_KEY`
   for the fallbacks (`GROQ_API_KEY` reaches the Worker as its own secret once
   the deploy workflow uploads it).
6. Run "Deploy Atlas web to Cloudflare Workers", then "Verify hosted Atlas" in
   `chat` mode.

A self-hosted model gets five minutes per request (hosted providers keep one).
When the machine or tunnel is down (connection refused, Cloudflare 520–524 or
530), chat routes to Groq without waiting.

## Live acceptance checks

Run **Verify hosted Atlas** manually with `inspect`, `chat`, then `coder`.
The workflow uses the existing operator secret without printing it. It also verifies
that a forged platform identity header is rejected on the public Worker.

Inspect must return findings into the conversation. Chat must return and persist
a nonempty reply. Coder must open a small documentation PR, deliver findings,
and include a `verified` baseline/post-change verdict. The workflow fails on an
empty green run. It uploads `smoke-result.json` as evidence; review the PR diff
and leave the smoke PR unmerged unless the documentation is wanted.

Public Workers must leave `ATLAS_TRUST_PLATFORM_HEADERS` unset. Only deployments
behind an ingress that removes client identity headers may opt in to that legacy
platform-header authentication path.

### Bounded repository reads

Hosted chat's `read_repository_file` returns 3000 characters by default (maximum
4000 per call). A partial file includes `nextOffset` and `fileSha`; continuation
calls pass these as `offset` and `fileSha`. A changed SHA refuses continuation so
the answer cannot silently combine different file versions. The original
allowlist, credential boundary and untrusted-data wrapper apply to every page.
The preview shows the returned page, not an implied complete file. Models must
read omitted sections before making claims about them. This lowers per-call
context pressure; it does not create provider quota or guarantee arbitrary files
can be completely read within the bounded chat tool loop.

## Actions budget availability

Self-hosted coder jobs check usage before starting the model. Missing credentials,
billing API failures, and malformed usage produce an explicit UNKNOWN verdict and
block by default. The guard writes budget.json; blocked runs also write status.json.
The job summary and hosted task result include the budget verdict even when a later
coder step completes successfully.

ATLAS_ACTIONS_UNKNOWN_POLICY accepts block (the default) or allow. Set allow only
for a workload permitted to run without confirmed allowance, such as a small CI
job invoking this guard. Invalid values block. This override never bypasses a
known insufficient allowance. Ordinary CI does not invoke the coder budget guard.
ATLAS_ESTIMATED_RUN_MINUTES and ATLAS_ACTIONS_MINUTES_RESERVE still control the
reservation arithmetic; they are estimates, not measured run-time guarantees.
