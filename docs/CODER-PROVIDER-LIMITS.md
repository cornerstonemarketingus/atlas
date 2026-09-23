# Coding within provider limits

Groq rejected the September 23 self-improvement run with HTTP 413: the fallback
requested 9,886 tokens against an 8,000 TPM allowance. Model context capacity is
not the same as the account's request allowance. Retrying the same oversized
request after a delay cannot fix this.

The hosted Groq coding path now bounds serialized requests to 18,000 UTF-8 bytes,
including tool schemas. This is a conservative heuristic, not an exact tokenizer
or guarantee against rate limits. Older successful repository read results are
replaced with explicit omission notices first. Recent source is retained where
possible; an oversized individual read requests a smaller range. Objectives,
tool-call arguments, write results, errors, and the original audit trace remain
intact. If those protected parts alone exceed the allowance, the run stops with
instructions to split the task or configure a larger allowance. Baseline and
post-edit verification remain mandatory under the existing verification policy.

Use small, specific objectives and bounded source ranges. Large complete-file
edits can still require a higher-tier provider. The byte policy does not apply
to Anthropic or self-hosted endpoints.

## Switching this deployment to Anthropic

In GitHub repository Settings → Secrets and variables → Actions:

- Add secret `ANTHROPIC_API_KEY` from your funded Anthropic API account.
- Set variable `ATLAS_CODER_MODEL` to `claude-sonnet-5`.
- Set variable `ATLAS_CODER_PROVIDER` to `anthropic`. The existing explicit
  `groq` value overrides model-name inference; changing only the model is insufficient.
- Review `ATLAS_CODER_FALLBACKS`: retaining the Groq fallback can still encounter
  Groq limits and sends repository context to Groq when that fallback is used.

No web deployment is required for coder workflow variables. Validate with a
small coding task, then a representative change; a green Chat check does not
verify the coding path. Anthropic also has account-specific per-minute limits:
https://platform.claude.com/docs/en/api/rate-limits

Never commit an API key or paste it into a task objective.
