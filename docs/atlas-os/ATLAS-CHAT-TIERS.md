# Atlas chat modes: Atlas and Super Atlas

Chat offers two modes, chosen in the composer's mode picker (a labelled radio
group). Provider names stay behind them. Code:
`apps/web/app/api/chat/chat-modes.mjs` (modes, entitlement, refusals) and
`paidChatRoute` in `apps/web/app/api/chat/providers.mjs`.

## Atlas (free)

Atlas is the whole [inference fabric](INFERENCE-FABRIC.md), unchanged. Automatic
rotates across every configured provider (a configured local or
OpenAI-compatible main model, Workers AI by binding or token, Groq, Cerebras,
the training tiers when the owner allows them, then OpenAI), each with its
fallback model, under the data-trust rule. Every existing model choice stays
selectable (`provider`: `auto`, `configured`, `configured:<model>`,
`workers-ai`, `openai`), so nothing Atlas could reach before is taken away.
The daily message cap per plan applies as before.

## Super Atlas (paid)

Super Atlas routes only to models the deployment pays for, strongest first,
each falling back to the next:

1. a main model on the OpenAI API (`ATLAS_CHAT_BASE_URL=https://api.openai.com/v1`
   with `ATLAS_CHAT_MODEL`), the operator's own choice of a stronger model;
2. OpenAI's default (`OPENAI_API_KEY`);
3. Gemini, OpenRouter or Mistral where the owner marked a paid plan with
   `ATLAS_<VENDOR>_TIER=paid` (vendor terms; `ATLAS_<VENDOR>_MODEL` picks the model).

No new runtime variable is needed; all of these are already uploaded by the deploy.

It is open only to an account with an active Pro or Team subscription
(`currentPlan` from `apps/web/app/api/billing/plan.mjs`, checked on the server
before any write or model call). As in #417, operator tokens and owner
privileges are not a subscription, and a billing lookup that fails keeps it
locked. Super Atlas picks its own models, so it accepts no `provider` other
than Automatic.

## Never a silent downgrade

The paid route has no free provider in it. When Super Atlas cannot answer, the
response says why, carries `fallbackMode: "atlas"`, and the composer offers a
one-step "Switch to Atlas". It never switches on its own:

| Code | Status | When |
|---|---|---|
| `SUPER_ATLAS_NOT_CONFIGURED` | 503 | the deployment pays for no model (checked first, so nobody is sold a mode that cannot answer) |
| `SUBSCRIPTION_REQUIRED` | 403 | no active Pro or Team plan; `upgradeUrl: "/pricing"` |
| `ENTITLEMENT_UNAVAILABLE` | 503 | the plan could not be read; retry |
| `SUPER_ATLAS_UNAVAILABLE` | as the provider answered | every paid model refused this turn (JSON, or the stream's `error` event) |

None of these sets `needsModelEndpoint`: free Atlas is still connected.

`GET /api/chat` returns `modes` beside the existing `configured`, `reason`
and `providers`: each mode's `available` flag and, when Super Atlas is not
available, its `code` and `reason`. It never includes an address or key.

## Not in scope

Gemini and Anthropic adapters beyond the catalog, turning app subscriptions
(ChatGPT, Claude, Gemini) into API access, and Stripe secrets or price IDs are
not part of this change.
