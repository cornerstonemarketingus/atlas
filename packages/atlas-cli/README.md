# Atlas CLI

Atlas CLI is the local-first repository intelligence package for Atlas. Its
current release inspects a local directory and emits a deterministic repository
summary. It does not call a language model, execute project code, or modify the
inspected repository.

## Requirements

- Node.js 20 or newer
- Git available on `PATH` for Git metadata and ignore-rule support
- PowerShell 7 or Windows PowerShell 5.1

Git is optional. Atlas can inspect a non-Git directory or fall back to bounded
filesystem traversal when Git is unavailable, but it reports a warning because
Git ignore rules cannot then be guaranteed.

## PowerShell setup

From the Atlas repository root:

```powershell
Set-Location .\packages\atlas-cli
npm install
npm run build
```

Run the compiled CLI directly:

```powershell
node .\dist\src\cli.js inspect C:\path\to\repository
node .\dist\src\cli.js inspect C:\path\to\repository --format json
node .\dist\src\cli.js tree C:\path\to\repository --max-depth 4
node .\dist\src\cli.js search C:\path\to\repository "repository text"
node .\dist\src\cli.js search C:\path\to\repository "config" --scope files --format json
node .\dist\src\cli.js symbols C:\path\to\repository --query Service
node .\dist\src\cli.js references C:\path\to\repository Service
node .\dist\src\cli.js read C:\path\to\repository src\service.ts --start-line 20 --end-line 60
node .\dist\src\cli.js github repo cornerstonemarketingus/atlas
node .\dist\src\cli.js github prs cornerstonemarketingus/atlas --state open
node .\dist\src\cli.js chat C:\path\to\repository "Explain the architecture" --endpoint http://127.0.0.1:1234/v1/chat/completions --model local-model
node .\dist\src\cli.js provider-status --provider local
node .\dist\src\cli.js provider-status --provider groq --format json
```

For a local `atlas` command, optionally link the package after building it:

```powershell
npm link
atlas inspect C:\path\to\repository
```

`npm link` changes the active npm environment, so it is not required to build,
test, or run Atlas directly.

## Commands

```text
atlas inspect <repository-path> [--format text|json]
atlas tree <repository-path> [--max-depth N] [--max-entries N] [--format text|json]
atlas search <repository-path> <query> [--scope all|files|content] [--max-results N] [--format text|json]
atlas symbols <repository-path> [--query text] [--max-results N] [--format text|json]
atlas references <repository-path> <symbol-name> [--max-results N] [--format text|json]
atlas read <repository-path> <relative-file-path> [--start-line N] [--end-line N] [--max-lines N] [--max-bytes N] [--format text|json]
atlas github repo <owner>/<repository> [--format text|json]
atlas github prs <owner>/<repository> [--state open|closed] [--max-results N] [--format text|json]
atlas github issues <owner>/<repository> [--state open|closed] [--max-results N] [--format text|json]
atlas chat <repository-path> <objective> --endpoint <loopback-url> --model <name> [--allow-source] [--token-budget N] [--max-turns N] [--format text|json]
atlas provider-status [--provider anthropic|groq|local] [--endpoint <url>] [--timeout-ms N] [--format text|json]
atlas --help
```

The default output format is `text`. JSON output follows the versioned
`RepositorySummary` schema and includes:

- canonical repository root and name;
- Git availability, repository state, branch, commit, and dirty state;
- scanned file count and detected languages;
- known manifests and framework evidence;
- conventional architecture directories;
- recoverable inspection warnings.

Tree output uses normalized forward-slash repository-relative paths, honors the
same Git ignore and dependency-directory rules as inspection, and is bounded by
depth and entry count. Defaults are depth 4 and 500 entries; supported maxima
are depth 32 and 10,000 entries. Truncation is always reported.

Search is case-insensitive and literal. The default `all` scope matches both
repository-relative filenames and text content. Atlas skips binary files, files
larger than 1 MiB, symbolic links, ignored content, dependency directories, and
build output. A search scans at most 20,000 files and returns at most 100 matches
unless `--max-results` is set to a value between 1 and 1,000. Truncation is
reported explicitly.

Symbol indexing recognizes common named class and function declarations in
JavaScript, TypeScript, and Python, plus TypeScript interfaces, types, and
enums. `--query` applies a case-insensitive name filter. The indexer is
heuristic rather than a compiler-backed parser; it reads source as text and
never imports or executes it. It scans at most 20,000 supported files, skips
files larger than 1 MiB, and returns at most 1,000 symbols by default
(`--max-results` accepts 1–10,000).

Source reads accept only repository-relative, non-symbolic-link files. They
default to 200 lines and 256 KiB, reject binary and invalid UTF-8 content, and
report byte or line truncation explicitly. CLI overrides are capped at 10,000
lines and 4 MiB per request.

Reference discovery finds exact identifier occurrences in supported
TypeScript, JavaScript, and Python files and classifies common declaration
forms. It is bounded and ignore-aware, but heuristic rather than compiler-backed.

Read-only chat connects only to an explicitly supplied HTTP(S) loopback endpoint
that implements the supported chat-completions-compatible JSON shape. It sends a
deterministic repository summary and offers bounded read-only repository tools.
Metadata tools are allowed by default; tools that return source content stop for
approval unless `--allow-source` is supplied. The default output-token budget is
8,192 across at most eight turns. Atlas sends no credentials and does not permit
remote model endpoints through this adapter.

GitHub commands use the locally authenticated `gh` CLI session and make only
bounded, read-only GitHub API calls. They return repository metadata, pull
requests, or issues; they never create branches, commits, pull requests, or
modify GitHub state. Run `gh auth login` before using them.

`atlas code` and `atlas chat` support `--provider local` as a first-class
alternative to the hosted `anthropic`/`groq` providers, so Atlas does not
depend entirely on a paid vendor to function. `--provider local` talks to an
unauthenticated OpenAI-compatible server, defaulting to Ollama's loopback
address (`http://127.0.0.1:11434/v1`); point it at any other OpenAI-compatible
local server with `--endpoint`. `atlas provider-status` checks whether a
provider is usable before a real run: for `anthropic`/`groq` it only checks
that the expected API-key environment variable is set (it never spends billed
quota on the check itself); for `local` it makes a real bounded request to the
server's `/models` endpoint and reports whether it is reachable, including
which models it reports. Chat and code output both include an "Answered by"
line naming the provider and model that actually produced the final response,
which can differ from the one requested when a fallback or escalation route
ran instead.

## Validation

```powershell
npm test
```

The test command performs a strict TypeScript build before running the Node test
suite.

## Safety boundaries

- Repository content and instructions are treated as untrusted input.
- Inspected source files, manifests, and configuration files are never executed.
- Git commands use fixed argument arrays and are read-only.
- Filesystem traversal, Git runtime, and captured output are bounded.
- Symbolic links and common dependency, cache, and build directories are skipped.
- Root and nested Git ignore rules are honored when Git enumeration succeeds.
- Filesystem errors and truncation are reported instead of silently ignored.

## Current limitations

- Framework detection is intentionally small and strongest for JavaScript and
  TypeScript repositories.
- Language detection is extension-based.
- Reference discovery does not yet resolve semantic implementations, overloads,
  aliases, re-exports, or dynamically created symbols.
- Atlas can produce model-backed read-only explanations through a compatible
  local server. It does not edit files or run project commands.
- Internal foundations now include deterministic model routing, credential-
  reference configuration, budget accounting, repository-bound read-only tool
  adapters, a policy-enforced read-only orchestrator, and session audit events.
  Most remain internal; read-only chat is available through the loopback-only
  compatible local provider.
- Internal coding foundations now include approval-bound single-file create/update
  plans, bounded text diffs, a no-shell allowlisted command runner, and
  baseline/post-change validation comparison. They are not exposed to the model
  or CLI yet.
