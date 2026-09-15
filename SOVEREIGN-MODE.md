# Atlas sovereign mode

Sovereign mode means the core product continues to work when every optional
hosted vendor is removed. The customer owns the model, repository, browser,
credentials, logs, and storage. Hosted services are convenience products, not
runtime dependencies.

## Working today

### Local coding

Install Node.js, Git, and Ollama; start Ollama and pull a model:

```text
ollama pull qwen2.5-coder:7b
```

Then run Atlas directly against any local Git checkout:

```text
node scripts/local/run-coder.mjs --repository C:\path\to\project --objective "Fix the failing test and verify the result"
```

The default endpoint is `http://127.0.0.1:11434/v1`. Repository evidence,
tool calls, edits, and validation remain on the machine. Audit records are
written under the user's `.atlas/runs` directory. Use `--help` for model,
context-window, verification-directory, and endpoint options.

### Local computer use

The Windows companion remains the default computer-control executor. Browser
profiles and device credentials stay on the customer's PC; consequential
actions still require approval. Pair this with the local coder to avoid model
and hosted-browser APIs entirely.

## Dependency boundary

| Capability | Sovereign path | Optional hosted path |
| --- | --- | --- |
| Model inference | Ollama or compatible local server | Groq/Anthropic/customer endpoint |
| Code repository | Local Git checkout | GitHub |
| Browser execution | Windows companion | Cloudflare Browser Rendering |
| Audit history | Local `.atlas/runs` files | Cloudflare D1/artifacts |
| Product UI | Local companion UI (in progress) | Cloudflare Worker |
| Remote access | Customer VPN or self-hosted tunnel | Cloudflare |

## Remaining product work

- [ ] Move task queues, approvals, policies, and audit browsing into the local
      companion so the hosted Worker is unnecessary for day-to-day use.
- [ ] Add local identity backed by the operating-system account and device
      keychain; GitHub OAuth must be optional.
- [ ] Add SQLite storage and encrypted export/import for tasks and settings.
- [ ] Replace GitHub-specific pull-request delivery with a Git host adapter:
      local branch/patch first, GitHub/GitLab/Forgejo optional.
- [ ] Package Ollama/model discovery, health checks, and model downloads in the
      Windows installer instead of requiring terminal setup.
- [ ] Add LAN and customer-managed HTTPS pairing for phone control without an
      Atlas-hosted relay.
- [ ] Ship signed Windows and mobile companions with reproducible release
      manifests and offline license verification.

## Commercial shape

The license should sell orchestration, safety policy, approval UX, auditability,
packaging, and support—not access to a particular model vendor. A customer may
buy Atlas once and supply all compute. Paid Atlas hosting can add managed relay,
backups, team policy, Cloudflare browser minutes, and supported model capacity
without making those services mandatory for the core product.
