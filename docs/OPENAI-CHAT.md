# OpenAI chat selection and fallback

Set `OPENAI_API_KEY` as an Atlas Cloudflare Worker secret. If deployment is
through GitHub Actions, create a repository Actions secret with that exact
name; the deploy workflow uploads it without logging the value. A secret
already set directly on the Worker remains there when the GitHub secret is
absent. Never put the key in browser storage or a model endpoint URL.

The hosted chat composer offers:

- **Automatic**: current endpoint and its existing same-provider recovery,
  then OpenAI on rate limits, temporary server errors, or request failures.
- **Configured provider**: existing endpoint and same-provider fallback only.
- **OpenAI · GPT-5.4 mini (paid API)**: use OpenAI directly.

OpenAI is disabled in the selector when no key is configured. With only the
OpenAI key and no primary endpoint/model, Automatic uses OpenAI. An invalid
explicit primary configuration remains an error. `ATLAS_CHAT_FALLBACK_MODEL=none`
disables automatic cross-provider fallback too; explicit OpenAI selection still
works. Selecting OpenAI can incur OpenAI API charges, including delegated chat
agent calls. Existing request limits remain in place.

The OpenAI target is fixed to `https://api.openai.com/v1/`; the browser only
sends an allowlisted provider ID. Requests use `max_completion_tokens` and
default to no reasoning to reserve the reply budget for visible output.
Streaming, tool calls, and synthesis use the same chat loop. Authentication
and invalid-request responses do not silently switch providers.

Model/API references: [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
and [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

This integration covers hosted chat and its delegated chat agents. It does
not change standalone coder-runner or local-daemon model configuration. Live
availability requires a funded OpenAI project with access to the model, a
deployed Worker with the secret, and a successful real chat verification.
