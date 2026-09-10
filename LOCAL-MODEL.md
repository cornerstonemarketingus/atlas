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
ATLAS_OLLAMA_VERSION    = v0.12.3              (a tag from ollama/ollama releases)
ATLAS_OLLAMA_SHA256     = <optional, see below>
```

The coder job then installs Ollama, starts it, pulls the model, and points
Atlas at `http://127.0.0.1:11434/v1`. With `ATLAS_SELF_HOSTED_MODEL` unset the
step is skipped entirely and nothing changes.

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

**Try it once by hand before trusting it to the schedule.** Dispatch
`atlas-coder.yml` manually with the variables set and read the timings in the
log. Estimates are estimates; the run tells you the truth.

### Known rough edge

A self-hosted model currently inherits the hosted profile's shape: 128k context
window, 4,096 max output tokens per turn. If your model has a smaller context —
say 32k — Atlas does not know, and requests may start failing once the
conversation grows past it. Making those configurable is not done.
