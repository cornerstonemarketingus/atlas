# Running Atlas on your own model

Atlas can drive a model you host instead of a vendor API. The agent's client is
an ordinary OpenAI chat-completions client, so anything that speaks that
protocol works: vLLM, Ollama, llama.cpp's server, TGI, LM Studio, or a rented
GPU.

There are two ways in, and they are independent.

---

## A. Point Atlas at a server you already run

Set one repository variable:

```
ATLAS_CODER_BASE_URL = https://your-server/v1
ATLAS_CODER_MODEL    = the model name that server serves
```

That is the whole integration. The URL is validated before anything is sent:

- **https is required for any remote host.** The prompt carries your repository
  content; every redaction boundary upstream is pointless if the transport is
  clear text.
- **Loopback may use plain http.** A request that never leaves the machine has
  no network to be intercepted on, and demanding a certificate for `localhost`
  only pushes people toward disabling TLS verification.
- **No credentials in the URL.** They would land in error messages, audit
  traces and CI logs, none of which redact the endpoint. Keys go in the API-key
  variable, which is redacted.
- The base URL is accepted and `/chat/completions` appended, so a value copied
  out of vLLM's or Ollama's README works unchanged.

If your server needs no API key, leave `GROQ_API_KEY` unset — the runner
supplies a placeholder when, and only when, a custom endpoint is configured.

**Exposing a home machine:** Cloudflare Tunnel gives you a free HTTPS hostname
without opening a port, which satisfies the https rule above.

---

## B. Run the model on the GitHub runner itself

Opt-in, off by default. Set:

```
ATLAS_SELF_HOSTED_MODEL = qwen2.5-coder:7b     (any Ollama model tag)
ATLAS_OLLAMA_VERSION    = v0.34.1              (a tag from ollama/ollama releases)
ATLAS_OLLAMA_SHA256     = <optional, see below>
```

The coder job then installs Ollama, starts it, pulls the model, and points
Atlas at `http://127.0.0.1:11434/v1`. With `ATLAS_SELF_HOSTED_MODEL` unset the
step is skipped entirely and nothing changes.

Atlas downloads the release's `ollama-linux-amd64.tar.zst` asset directly.
If Ollama changes its release packaging again, the download fails explicitly;
Atlas never falls back to piping a remote installer script into a shell.

`ATLAS_OLLAMA_VERSION` is required rather than defaulted. This job has access
to the repository, and piping an unpinned remote installer into a shell would
undo the action pinning used everywhere else in these workflows. The first run
prints the archive's `sha256`; put that in `ATLAS_OLLAMA_SHA256` and it is
enforced from then on.

### Read this before turning it on

The runner is **4 vCPU, 16 GB RAM, no GPU**. That is a real constraint, not a
formality:

| | Hosted API | On the runner's CPU |
|---|---|---|
| Wall time per run | 1–3 minutes | **1–2 hours** |
| Model you can run | 120B+ | ~7B at 4-bit |
| Cost | per token | Actions minutes |

**On a private repository, Actions minutes are not free.** The Free plan
includes 2,000 per month. Thirty nightly runs at 60–120 minutes is
1,800–3,600 minutes — at best your entire allowance with nothing left for CI,
at worst roughly $15/month in overage at $0.008/minute. On a public repository
they are free and this concern disappears.

The quality question is the more important one. This agent has to read a
repository, choose a task, make a coherent multi-file edit, write tests that
fail without the change, and recover from its own mistakes across many turns of
tool calls. A 7B model is markedly worse at sustained tool use than the hosted
models Atlas normally uses, and most runs are likely to end in a change that
fails verification.

That failure mode is at least a safe one: Atlas runs the repository's own
checks before and after every edit, and a change that fails is reported as
regressed rather than proposed as if it were fine. You get a wasted run, not a
broken main branch.

### The minutes guard

Because those minutes are real money, a self-hosted run checks the account's
remaining Actions allowance before it starts and refuses if the run would eat
into a reserve held back for ordinary CI:

```
ATLAS_ESTIMATED_RUN_MINUTES   = 120   (what a CPU run costs; default)
ATLAS_ACTIONS_MINUTES_RESERVE = 300   (kept free for CI; default)
```

It **fails open**. If the budget cannot be read — the token has no billing
permission, the API is down — the run proceeds and prints why it could not
check. A permissions gap that silently blocked every run would get the guard
switched off, and a guard that is off protects nothing. Hosted-API runs are
not checked at all: three minutes does not need a guard.

**Try it once by hand before trusting it to the schedule.** Dispatch
`atlas-coder.yml` manually with the variables set and read the timings in the
log. Estimates are estimates; the run tells you the truth.

### Context window: one number, two places

Ollama serves a **4,096-token** window by default. Atlas's prompts are larger
than that — a real run measured 12,077 tokens on its first request — so a
mismatch here does not error, it truncates: the model receives the tail of the
prompt, answers from a fragment, and nothing anywhere reports a fault. A
confidently wrong answer is the worst failure this agent can have.

So the window is stated explicitly and fed to both sides from one variable:

```
ATLAS_CODER_CONTEXT_WINDOW    = 16384   (default if unset)
ATLAS_CODER_MAX_OUTPUT_TOKENS = 2048    (default if unset)
```

`ATLAS_CODER_CONTEXT_WINDOW` becomes `OLLAMA_CONTEXT_LENGTH` for the server
*and* the window Atlas declares for the model, so the two cannot drift apart.
Output is capped low because generation is the slow part on a CPU. Both are
refused outright if passed without a `--base-url`, rather than silently
describing a limit that is not the one in force.

Raising the window costs RAM: the KV cache grows with it, and the runner has
16 GB shared with the model weights. 16k is a deliberate floor-to-ceiling
compromise; 32k is plausible with a 7B model at 4-bit, 64k is not.

---

## C. The Chat section in the web app

The Chat section talks to the same kind of endpoint, configured on the
**Cloudflare Worker** rather than on the GitHub runner:

```
ATLAS_CHAT_BASE_URL  = https://your-server/v1
ATLAS_CHAT_MODEL     = the model name that server serves
ATLAS_MODEL_API_KEY  = only if your server needs one
```

If those are unset it falls back to `ATLAS_CODER_BASE_URL`,
`ATLAS_CODER_MODEL` and `GROQ_API_KEY`, so one endpoint can serve both. The
same transport rules apply — HTTPS for any remote host, plain HTTP only for
loopback, and never credentials in the URL.

With nothing configured, Chat says so: Connections shows "No model endpoint",
the composer explains why it cannot answer, and the send button is disabled.
Atlas does not fabricate a reply, for the same reason it never invents a
preview URL.

Note that a Worker cannot reach `localhost` — a loopback endpoint only works
when you run the web app locally (`npm run dev` in `apps/web`, with the
variables in `.dev.vars`). A deployed Worker needs a reachable HTTPS endpoint;
Cloudflare Tunnel is the free way to give a home machine one.
