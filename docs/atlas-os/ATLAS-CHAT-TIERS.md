# Atlas chat modes

The public chat menu exposes Atlas and Super Atlas. Provider names remain internal.

Atlas uses the Workers AI binding (no provider API key) or the existing Workers AI REST credentials, with Llama 3.1 8B. It never falls back to premium models. Cloudflare quota and billing still apply.

Super Atlas requires an active Pro or Team subscription, verified server-side before any conversation writes, model requests or team execution. Operator tokens and owner privileges do not substitute for a paid subscription. Billing lookup failures leave Super Atlas locked. Raw provider/model IDs cannot bypass this gate; legacy auto requests resolve to basic Atlas.

Super Atlas retains the existing configured provider/fallback route. Both modes retain the existing specialist agent team, including bounded planning, delegation, verification and child agents. These roles can share one connected model; separate provider keys are not required for separate agent roles. No model capacity means no live inference.

Gemini and Anthropic adapters are not added by this change. Codex, ChatGPT, Claude and Gemini app subscriptions are not API credentials. No external-provider access is claimed without its supported adapter and credentials. Existing OpenAI/Groq/Workers AI routing continues for Super Atlas.

Stripe checkout still requires the deployment Stripe secrets and price IDs. This change does not fabricate subscriptions, enable paid cloud billing, or impose a dollar spending cap.
