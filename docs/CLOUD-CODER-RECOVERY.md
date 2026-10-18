# Cloud coder recovery

Incident: [run 38819478158](https://github.com/cornerstonemarketingus/atlas/actions/runs/38819478158).
The coder spent 23 tool turns without an edit, twice hit PARENT_NOT_DIRECTORY
when writing the requested Minnesota framing site, then exhausted its Groq
routes (8,503 tokens against an 8,000 TPM allowance). Results were delivered;
the 11m48s work step failed rather than remaining active.

## Implemented repair

- Approved file creates can materialize missing repository-relative parent
  directories. Preview and denied/tampered approvals create nothing. Every
  existing parent is rechecked for symlinks/non-directories before mutation.
  Updates, deletes and renames retain their existing path requirements.
  Transaction rollback restores files; new empty directories may remain.
- The coder CLI supports `groq`, `anthropic`, `openai`, and `workers-ai`.
  OpenAI and Workers AI use fixed vendor destinations, bounded responses,
  cancellation and sanitized errors. API redirects are refused. Namespaced
  Atlas tools map to valid cloud function names and back to exact registry IDs.
  OpenAI uses max_completion_tokens; Workers AI uses the compatible payload.
- The cloud runner includes available Workers AI/OpenAI/Groq recovery routes
  after explicit fallback routes. With no primary/model setting it prefers
  Workers AI, then OpenAI, then Groq. Explicit provider/model choices still win.
  `ATLAS_CODER_FALLBACKS=none` disables every fallback. A custom/private
  ATLAS_CODER_BASE_URL never gains public-cloud fallbacks implicitly.
- Auth failures remain explicit and do not change providers. Capacity/model
  failures continue the same model request through the existing fallback
  wrapper, without restarting the agent or replaying tool execution.
- The trusted CLI emits numeric model/tool/error counters every 15 seconds;
  the runner logs elapsed time and those counters every 30 seconds. Prompts,
  file contents, arguments and provider error bodies are not progress data.
  Output capture and timeouts remain bounded; a timed-out process cannot
  report a successful completion from earlier JSON output.

## Configuration after this change reaches main

The coder workflow checks out trusted main. A PR or branch alone does not
activate these changes for normal dispatched tasks. Protected workflow and
execution-boundary review must finish first.

| Provider | Repository secret | Model configuration |
|---|---|---|
| Workers AI | ATLAS_WORKERS_AI_TOKEN and CLOUDFLARE_ACCOUNT_ID | ATLAS_CODER_PROVIDER=workers-ai; ATLAS_CODER_MODEL=@cf/openai/gpt-oss-120b (or selected compatible model) |
| OpenAI | OPENAI_API_KEY | ATLAS_CODER_PROVIDER=openai; ATLAS_CODER_MODEL=gpt-5.4-mini (or selected compatible model) |
| Anthropic | ANTHROPIC_API_KEY | ATLAS_CODER_PROVIDER=anthropic; ATLAS_CODER_MODEL must name the intended Claude model |
| Groq | GROQ_API_KEY | Existing Groq variables retain their meaning |

Only credential names were inspected for the incident: Workers AI, Cloudflare
account ID and OpenAI secret names are present. This does not establish their
current validity, permissions, balance or model availability. No secret was
copied or new provider account provisioned.

Explicit route examples:

```
ATLAS_CODER_FALLBACKS=workers-ai:@cf/openai/gpt-oss-120b:ATLAS_WORKERS_AI_TOKEN,openai:gpt-5.4-mini:OPENAI_API_KEY
```

Configured routes share the existing task output-token budget. This change does
not establish a new global monetary ledger or a dedicated GPU fleet. Cloud
inference and finite GitHub Actions jobs do not depend on the owner's PC;
persistent workspace leases/checkpoint migration remain the separate cloud
execution workstream.

## Verification scope

Regression first reproduced the nested-directory failure. Tests cover preview
purity, exact approval, symlink replacement, cloud provider/key separation,
no credential redirects, HTTP 413 to Workers AI, authenticated-error refusal,
empty/oversized replies, cancellation, fixed function-name round trip, output
limits, timeout cleanup and metadata-only progress. A registry integration
writes all five framing-site files after a simulated Groq refusal; an actual CLI
subprocess test exercises nested-file creation and change receipts.

Provider HTTP responses are scripted fixtures. Live model quality and production
website delivery are not claimed. After merge, verify the selected cloud route
with a bounded real coder task, inspect actual edits/verification/PR, then retry
the framing-site request. Do not mistake a green workflow or repository URL for
a deployed website.

API references: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
[Workers AI compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/).

## Automatic PR repair scope

The owner explicitly approved the scoped credential extension on October 16.
Both the main coder and the PR-steward now declare the same existing cloud
credentials only in their trusted coder steps. The steward checks out trusted
main, restricts workflow-run repairs to same-repository atlas/task branches,
disables dependency install scripts and uses scrubbed validation child
environments. Protected workflow review still applies before deployment.
