# Atlas

Atlas is an AI-native software engineering platform under incremental
development. The current release is a safe, local-first TypeScript CLI that can
inspect another Git repository and produce a deterministic structured summary.

## Current release

The canonical implementation lives in [`packages/atlas-cli`](packages/atlas-cli).
The hosted control plane lives in [`apps/web`](apps/web) and provides a private,
authenticated task-intake surface for approval-gated autonomous changes.

Requirements:

- Node.js 20 or newer
- Git on `PATH` for repository metadata and ignore-rule support
- PowerShell 7 or Windows PowerShell 5.1

From the repository root:

```powershell
Set-Location .\packages\atlas-cli
npm install
npm test
npm run build
node .\dist\src\cli.js inspect C:\path\to\repository
node .\dist\src\cli.js inspect C:\path\to\repository --format json
node .\dist\src\cli.js tree C:\path\to\repository --max-depth 4
node .\dist\src\cli.js search C:\path\to\repository "search text"
node .\dist\src\cli.js symbols C:\path\to\repository --query Service
node .\dist\src\cli.js references C:\path\to\repository Service
node .\dist\src\cli.js read C:\path\to\repository src\service.ts --start-line 20 --end-line 60
node .\dist\src\cli.js chat C:\path\to\repository "Explain the architecture" `
  --endpoint http://127.0.0.1:1234/v1/chat/completions `
  --model local-model
```

See the [CLI documentation](packages/atlas-cli/README.md) for its output schema,
safety boundaries, and local linking instructions. Development status and
ordered next assignments are tracked in [`TODO.md`](TODO.md).

### Implemented

- Strict TypeScript build
- PowerShell-compatible local CLI
- Text and JSON repository summaries
- Git state, language, manifest, framework, and architecture detection
- Root and nested Git ignore support
- Bounded traversal with symlink exclusion
- Explicit warnings for truncation and recoverable failures
- Bounded literal filename and content search
- Bounded TypeScript, JavaScript, and Python symbol indexing
- Bounded contextual UTF-8 source reads by repository-relative path and line range
- Normalized repository-relative path and source-location contracts
- Bounded, ignore-aware directory tree output with text and JSON formats
- Bounded heuristic declaration/reference discovery
- Provider-neutral model contracts with an offline deterministic mock provider
- Runtime validation for untrusted provider data and a bounded read-only planning loop
- Typed tool-capability policy evaluation without tool execution
- Capability-enforced read-only tool registry and atomic usage-budget ledger
- Repository-bound read-only tool adapters and bounded tool-calling orchestrator
- Deterministic capability-based model registry and provider configuration types
- Metadata-only session audit events with a bounded append-only in-memory log
- Loopback-only local model chat with bounded, policy-enforced read tools
- Persistent JSON Lines audit storage and one-time approval-resume tokens
- Internal approval-bound create/update primitives with optimistic concurrency
- Internal no-shell command runner and baseline/post-change validation comparator
- Fixture coverage for Git, non-Git, unborn, detached-HEAD, ignored, malformed,
  mixed-language, and unreadable-path cases

### Not implemented yet

- Model-provider integration
- Public repository editing and validation workflows (internal approval-bound primitives exist)
- Branch, commit, pull-request, browser, or multi-agent workflows
- Public agent-driven code editing, validation execution, and repair workflows
- Production agent-runner dispatch and hosted GitHub write credentials

## Hosted control plane

The web application builds to a Cloudflare Worker-compatible bundle and includes
deployment metadata for Sites plus a root Vercel descriptor. Task submission is
authenticated server-side and forwards only to a configured Atlas agent runner.
GitHub credentials remain server-side; commit mode is approval-required.

Configure `ATLAS_AGENT_DISPATCH_URL` and `ATLAS_AGENT_DISPATCH_TOKEN` as hosted
secrets. The runner must validate the task ID, repository allowlist, requested
user, approval, branch, and exact change-set digest before committing.

For production GitHub access, configure a GitHub App using
`ATLAS_GITHUB_APP_ID`, `ATLAS_GITHUB_INSTALLATION_ID`,
`ATLAS_GITHUB_APP_PRIVATE_KEY`, and `ATLAS_GITHUB_APP_SLUG`. Atlas exchanges the
private key for short-lived installation tokens server-side. A personal token
remains supported only as a single-operator fallback.
Set `ATLAS_ALLOWED_REPOSITORIES` to a comma-separated list of `owner/repository`
names that may be submitted from the hosted task composer.

## Legacy Python prototype

The root `src/atlas_agent` package is an earlier experimental prototype. It is
retained temporarily to avoid deleting uncommitted work, but it is not the
canonical Atlas release and is not integrated with the TypeScript CLI.

Its historical documentation follows.

## Atlas Agent Starter (legacy)

Lightweight local agent scaffold with a command-line interface and pluggable tools.

## Features

- Minimal command router
- Tool plugin pattern
- Sample built-in `time` tool
- Local-only LLM tool backed by your own checkpoint
- Environment-based runtime configuration
- Basic automated tests

## Quick Start

1. Create and activate a virtual environment.
2. Install dependencies:

```powershell
pip install -r requirements.txt
```

3. Start the agent:

```powershell
python -m atlas_agent.cli
```

## Commands

- `help` -> Show command help
- `tools` -> List loaded tools
- `run time` -> Return current UTC time
- `run local-llm <prompt>` -> Generate with your own local model
- `exit` -> Quit the session

## Build Your Own Local LLM (No External API)

This repository includes an offline training and inference path. It does not call
OpenAI, Anthropic, or any hosted LLM service.

1. Install project and local LLM dependencies:

```powershell
pip install -r requirements.txt
pip install -e .[local-llm]
```

2. Place your training text in `data/corpus.txt` (or another file path).
3. Train your checkpoint locally:

```powershell
python -m atlas_agent.local_llm.train --corpus data/corpus.txt --output models/local_llm.pt
```

For a quick smoke test, use fewer steps:

```powershell
python -m atlas_agent.local_llm.train --corpus data/corpus.txt --steps 20 --eval-interval 10 --eval-iters 2 --batch-size 4 --block-size 32 --output models/local_llm.pt
```

You can also use the script entrypoint:

```powershell
atlas-train-local-llm --corpus data/corpus.txt --output models/local_llm.pt
```

4. Run the agent and query your model:

```text
run local-llm Explain our deployment process
```

Optional environment variable:

- `ATLAS_LOCAL_MODEL_PATH` (default: `models/local_llm.pt`)

Notes:

- Quality depends heavily on dataset quality and size.
- Minimum data requirement is approximately `2 * (block_size + 2)` characters/tokens.
- For meaningful results, expand corpus data beyond the starter sample.
- CPU training works but is slower than CUDA.

## Configuration

Set optional environment variables before launch:

- `ATLAS_AGENT_NAME` (default: `atlas`)
- `ATLAS_PROMPT_PREFIX` (default: `atlas> `)
- `ATLAS_LOCAL_MODEL_PATH` (default: `models/local_llm.pt`)

## Run Tests

```powershell
python -m unittest discover -s tests -v
```
