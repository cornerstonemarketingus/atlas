# Free-tier provider pool (hosted chat)

Hosted chat stops when every provider in its route refuses. The live check on
2026-10-19 (`verify-hosted` chat, run 39105457659) showed why the route was
too short:

- Groq refused: one Atlas request is larger than Groq's free per-minute token
  allowance.
- Workers AI refused: the account's free daily allocation was spent.
- OpenAI refused: the account has no API credits.

Free allowances are per account and per day, so adding providers adds
capacity. Each key below is optional. Add a key and that provider joins
Automatic.

## Route

```
main model → its fallback model → Workers AI → Groq
  → Cerebras → NVIDIA → Gemini (Flash, then Flash-Lite) → OpenRouter
  → OpenAI (paid, last)
```

- A provider that is already in the route is not repeated.
- A provider without a key is not in the route.
- `ATLAS_CHAT_FALLBACK_MODEL=none` still means no fallback route.
- Each key is sent only to its own provider's fixed origin, never to a
  configurable URL.
- A request larger than a provider's declared window skips that provider.
  It is never sent there.
- A 402 (no credits) moves on to the next provider. A 401/403 (bad key) is
  shown to you, not routed around.

## Keys (repository **secrets**, uploaded to the Worker on deploy)

| Secret | Free allowance (checked 2026-10-19; providers change these) | Default model |
|---|---|---|
| `CEREBRAS_API_KEY` | Per model: 1M tokens/day, 30k uncached input tokens/min, 5 requests/min | `gpt-oss-120b` (64k window held) |
| `NVIDIA_API_KEY` | About 40 requests/min shared across models, no daily token cap; needs phone verification | `openai/gpt-oss-120b` |
| `GEMINI_API_KEY` | Per-model daily request limits (see AI Studio) | `gemini-flash-latest`, then `gemini-flash-lite-latest` |
| `OPENROUTER_API_KEY` | 20/min; 50 requests/day, or 1,000/day once the account has bought about $10 of credits | `openai/gpt-oss-120b:free` |

`ATLAS_PROVIDER_MODELS` overrides a model. Use comma-separated
`provider=model` pairs, e.g. `openrouter=qwen/qwen3-coder:free`. Unknown
providers and invalid names are ignored. An overridden model drops the
default's declared window, so Atlas does not assume a limit it cannot know.

Every pool provider also appears in the chat **Model** menu once its key is
set. Choosing one makes it the first provider; the rest of the route stays
as recovery.

You can also point `ATLAS_CHAT_BASE_URL` straight at one of these providers.
Its own key is then used when `ATLAS_MODEL_API_KEY` is empty.

## Before you add a key: data use

The free tiers of Gemini and many OpenRouter `:free` models may use prompts
to improve their models. Chat can carry repository content. For proprietary
code, either use providers whose terms you have checked, or keep the work on
your own model (`LOCAL-MODEL.md`, `SOVEREIGN-MODE.md`).

## Not covered yet

- **The coder route.** The coder (`scripts/runner/coder-routes.mjs`, atlas-cli
  providers) still knows only Groq, Workers AI, OpenAI and Anthropic. It can
  already use any single one of these providers through
  `ATLAS_CODER_BASE_URL`. Pool fallback for the coder is the next slice.
- **Live acceptance.** No live acceptance has been run against these
  providers yet. After adding keys and deploying, run "Verify hosted Atlas"
  in `chat` mode. The route it prints should list the new providers.
