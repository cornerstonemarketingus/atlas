# Atlas CLI

`atlas` is Atlas's command-line tool for working on a repository. It has three
groups of commands:

- **Offline repository intelligence.** Inspect, tree, search, symbols,
  references, read, tests-for, packages, ci, map, surfaces, schemas and env.
  These read files, never execute repository code and need no network.
- **Utilities.** `redact` (scrub credentials from text) and `replay`
  (reconstruct a coder session from its audit log). `undo` puts back the files
  a coder session changed.
- **Model and GitHub commands.** `chat` (read-only, loopback model only),
  `code` (edits files and runs the repository's own checks) and `github`
  (read-only, through `gh`).

The reference below is generated from `src/cli.ts`. The offline examples were
run against this repository.

## Requirements and setup

- Node.js 20 or newer.
- Git on `PATH`, for Git metadata and ignore rules. Without it, Atlas falls
  back to bounded filesystem traversal and warns that ignore rules are not
  applied.
- `gh`, authenticated with `gh auth login`, for the `github` commands only.

```sh
cd packages/atlas-cli
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --help
```

The package declares `bin.atlas`, so `npm link` gives you an `atlas` command.
The examples below use `atlas` and assume they are run from the repository
root. Without the link, run `node packages/atlas-cli/dist/src/cli.js`.

`atlas --help` prints the usage for every command. There is no per-command
help: `atlas <command> --help` prints the same full list.

## Conventions

- Most commands take `--format text|json`, and text is the default. JSON output
  of `inspect`, `tree`, `search`, `symbols`, `references` and `read` follows
  versioned schemas. The other commands print their result object as JSON.
- Warnings, progress and diagnostics go to stderr. Results go to stdout.
- Exit codes: `0` means success, `1` means the command failed or reached a
  negative outcome (for example a coder run that did not complete, or an undo
  with conflicts), and `2` means invalid usage or a missing option or
  environment variable.

## Command reference

### Repository intelligence (offline)

**`atlas inspect <repository-path>`** prints a deterministic repository
summary: canonical root and name, Git state (branch, commit, dirty), file
count, languages (by extension), manifests, framework evidence, conventional
architecture directories and warnings.

```sh
atlas inspect . --format json
```

**`atlas tree <repository-path> [--max-depth N] [--max-entries N]`** prints an
ignore-aware directory tree. Defaults are depth 4 and 500 entries. The maxima
are depth 32 and 10,000 entries. Truncation is reported.

```sh
atlas tree packages/atlas-cli --max-depth 2
```

**`atlas search <repository-path> <query> [--scope all|files|content] [--max-results N]`**
runs a literal, case-insensitive search over file names (`files`), file
contents (`content`) or both (`all`, the default). It skips binary files,
files over 1 MiB, symbolic links, ignored and dependency directories, and
build output. It scans at most 20,000 files and returns 100 matches by default
(1–1,000 allowed).

```sh
atlas search . "ATLAS_MCP_DB" --scope content
```

**`atlas symbols <repository-path> [--query text] [--max-results N]`** is a
heuristic symbol index of classes and functions in JS, TS and Python, plus TS
interfaces, types and enums. It returns 1,000 symbols by default (up to
10,000).

```sh
atlas symbols packages/atlas-cli --query Redactor
```

**`atlas references <repository-path> <symbol-name> [--max-results N]`** finds
exact identifier occurrences in TS, JS and Python and classifies common
declaration forms. It is heuristic, not compiler-backed.

```sh
atlas references packages/atlas-cli PatternSecretRedactor
```

**`atlas read <repository-path> <relative-file-path> [--start-line N] [--end-line N] [--max-lines N] [--max-bytes N]`**
reads part of a file inside the repository and refuses symbolic links. The
default limit is 200 lines and 256 KiB, and the caps are 10,000 lines and
4 MiB. Binary and invalid UTF-8 content is rejected. Truncation is reported.

```sh
atlas read . packages/atlas-cli/src/cli.ts --start-line 1 --end-line 40
```

**`atlas tests-for <repository-path> <relative-file-path> [--depth N]`** lists
the test files that import the given source file, directly or through up to
`--depth` hops (default 4, maximum 10), with the import chain for each. The
file must be a TS, JS or Python source file. Otherwise the command exits 1.

```sh
atlas tests-for . packages/atlas-cli/src/cli-redact.ts
```

**`atlas packages <repository-path>`** lists every `package.json` and
`pyproject.toml` package with its version, ecosystem, dependency counts by kind
and internal (workspace) dependencies.

```sh
atlas packages .
```

**`atlas ci <repository-path>`** finds CI systems and shows, for each GitHub
Actions workflow, its triggers, branches, jobs and the deploy steps it detects.
It ends with the list of deploy targets and the evidence for each.

```sh
atlas ci .
```

**`atlas map <repository-path>`** gives a one-page overview: packages (source
and test counts, how many source files tests reach, entry points and internal
dependencies), the most-imported files, configuration variables (including
ones read but never declared), delivery targets, migrations and API schemas.

```sh
atlas map .
```

**`atlas surfaces <repository-path>`** lists HTTP entry points and whether an
auth guard was found in the same file, plus security-relevant sinks grouped by
kind. A missing guard only means none was found in that file. The server that
dispatches to the route may still guard it, so confirm by reading the code.

```sh
atlas surfaces . --format json
```

**`atlas schemas <repository-path>`** lists migration sets (with duplicate
sequence numbers and drift from the ORM schema), tables, and OpenAPI/GraphQL
schemas.

```sh
atlas schemas .
```

**`atlas env <repository-path> [--name NAME] [--undeclared]`** lists the
environment variables the code reads, where each is read or declared
(example files, workflow `env`/`vars`, wrangler vars), and which are read but
never declared. It finds references the scanner recognizes, such as
`process.env.X` and workflow env.

```sh
atlas env . --name ATLAS_CODER_BASE_URL
atlas env . --undeclared
```

### Utilities

**`atlas redact [--max-characters N] [--summary]`** reads stdin and writes the
same text to stdout with credentials replaced by `[redacted:<category>:<id>]`
placeholders. It reads at most 4 MiB characters by default (up to 64 MiB).
`--summary` writes the counts per category to stderr. If redaction fails,
nothing is written to stdout and the command exits 1. The GitHub Actions runner
uses this to clean logs before uploading them.

```sh
printf 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' | atlas redact --summary
# stdout: token=[redacted:github-token:8e7332bf]
# stderr: redactions=1 scanned=47 truncated=false findings: github-token=1
```

**`atlas replay <audit-log.jsonl> [--session <id>]`** rebuilds each session in
a JSONL audit log (written by `atlas code --audit-log`): its outcome, its
turns, the tool calls in each turn, and token totals. Unreadable lines, such as
a half-written last line, are counted on stderr and skipped. The rest is still
rebuilt.

```sh
atlas code . "Fix the failing test" --model claude-sonnet-5 --audit-log /tmp/audit.jsonl
atlas replay /tmp/audit.jsonl
```

**`atlas undo <repository-path> [--session <id>] [--dry-run]`** puts back
every file a coder session changed. Without `--session` it uses the most recent
session. Before a coder session edits a file, its original content is saved to
`.git/atlas/checkpoints/<session>.json` (the system temp directory outside a
Git checkout), so the checkpoint is never committed. If any of those files
changed after the session, nothing is restored, the conflicts are listed and
the command exits 1. `atlas code` prints the exact undo command on stderr.

```sh
atlas undo . --dry-run
# "No coder session to undo in this repository." (exit 1) when there is none
```

### Model and GitHub commands

**`atlas chat <repository-path> <objective> --endpoint <loopback-url> --model <name> [--allow-source] [--token-budget N] [--max-turns N]`**
asks a question about the repository using a model you run locally. The
endpoint must be an HTTP(S) loopback URL serving an OpenAI-compatible
chat-completions API. The model gets the repository summary and read-only
tools. Metadata tools are allowed. Tools that return source content stop for
approval unless you pass `--allow-source`. Content sent to the model and the
printed answer are both redacted. By default the run has 8,192 output tokens
and 8 turns. No credentials are sent.

```sh
atlas chat . "Where is the MCP server started?" --endpoint http://127.0.0.1:11434/v1/chat/completions --model qwen2.5-coder:7b
```

**`atlas code <repository-path> <objective> --model <name> [options]`** is the
coder. A hosted model searches and reads the repository and then **writes
files**. It edits through `repository.propose_change_set`: atomic create,
update, delete and rename within the repository, with a 1 MiB file limit. Then
the coder **runs the repository's own checks** and repairs failures within the
limits below. Output (JSON with `--format json`) is redacted before it is
printed.

- Provider: `--provider anthropic|groq|openai|workers-ai|cerebras|gemini|openrouter|mistral`.
  Without it, the provider is inferred from the model name: `@cf/…` →
  workers-ai, `…:free` → openrouter, `gemini-…` → gemini,
  `mistral-|devstral-|codestral-|magistral-…` → mistral, `gpt-…`/`o1|o3|o4` →
  openai, `claude…` → anthropic, anything else → groq. Cerebras must be named
  explicitly.
- Key: read from `--api-key-env <VAR>`, or from the provider's default
  variable (`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`,
  `ATLAS_WORKERS_AI_TOKEN`, `CEREBRAS_API_KEY`, `GEMINI_API_KEY`,
  `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`). A missing key exits 2. Workers AI
  also reads `CLOUDFLARE_ACCOUNT_ID`.
- Self-hosted: `--base-url` (or `ATLAS_CODER_BASE_URL`) points the
  Groq/OpenAI-compatible path at your own server. `--context-window` and
  `--max-output-tokens` (or `ATLAS_CODER_CONTEXT_WINDOW` and
  `ATLAS_CODER_MAX_OUTPUT_TOKENS`) state that server's limits. They are
  refused without `--base-url`, and `--base-url` is refused for any provider
  other than groq.
- Routing: `--fallback provider:model:KEY_ENV` (repeatable) for other routes,
  `--escalate provider:model:KEY_ENV` for a stronger model on repairs
  (`--escalation-attempts`, 1–5, default 2), `--retry-attempts` (1–5, default
  3), `--retry-max-delay-ms` (default 60,000) and `--capacity-wait-ms` (how long
  to wait for capacity when every route is out, default 300,000). With
  `ATLAS_GOVERNOR_URL` and `ATLAS_GOVERNOR_TOKEN` set, calls reserve capacity
  from the shared inference governor. All routes share one output-token budget.
- Budget: `--token-budget` (default 16,384 output tokens), `--max-turns`
  (default 12), `--output-tokens-per-turn`.
- Verification: the coder plans up to six checks from the `typecheck`, `lint`,
  `build` and `test` scripts in `package.json` and runs each as
  `<package manager> run <script>` (`--verify-package-manager`, default `npm`).
  It runs them with no shell, with a timeout (`--verify-timeout-ms`, default
  600,000) and with only a short environment allowlist, so model and GitHub
  keys are not passed. `--verify-dir` points at a sub-package. `--no-verify`
  skips verification.
- Repair limits: `--max-repair-attempts` (0–5, default 2), `--max-repair-ms`,
  `--max-same-failure`.
- `--dry-run` denies every write, so the model can read and propose but
  nothing lands.
- `--audit-log <path>` writes a redacted JSONL session trace for
  `atlas replay`.

```sh
ANTHROPIC_API_KEY=… atlas code . "Make tests-for accept a directory" --model claude-sonnet-5 --verify-dir packages/atlas-cli
```

**`atlas github repo|prs|issues <owner>/<repository> [--state open|closed] [--max-results N]`**
makes bounded, read-only GitHub API calls through your `gh` session. These
commands never create or change anything on GitHub.

```sh
atlas github prs cornerstonemarketingus/atlas --state open --max-results 5
```

## Safety boundaries

- Repository content is treated as untrusted. The offline commands read files
  as text and never import or run them. Git is called with fixed, read-only
  arguments.
- Traversal, file sizes, Git output and command output all have limits.
  Truncation and errors are reported, never dropped silently.
- `chat` and `code` redact credentials from what goes to the model and from
  what they print. `chat` only talks to loopback endpoints.
- `code` writes only inside the repository, through the atomic change-set
  editor. It records an undo checkpoint first. The only program it runs is the
  package manager, with the repository's own scripts, no shell and an
  environment allowlist.

## Current limitations

- `code` runs whatever the repository's `typecheck`, `lint`, `build` and
  `test` scripts do. The environment allowlist keeps Atlas's keys out of those
  scripts, but they are not sandboxed beyond that. Run `code` only on
  repositories whose scripts you trust, or use `--no-verify`.
- `code` sends repository content (redacted) to the hosted provider you choose.
  Only `chat` is limited to a local model.
- `code` has no interactive approval step. Writes are either all allowed or,
  with `--dry-run`, all denied. Review the result (or `atlas undo` it) before
  committing. The CLI does not commit, push or open pull requests. The GitHub
  Actions runner in `scripts/runner/` does that around it.
- `undo` restores only files changed by a coder session that saved a
  checkpoint. It does not touch other edits.
- Verification only plans checks from `package.json` scripts, so other build
  systems are not verified.
- Symbol and reference discovery are heuristic: they do not resolve overloads,
  aliases, re-exports or dynamically created symbols. Language detection goes
  by file extension, and framework detection is strongest for JS/TS.
- `env` sees only the access patterns its scanner recognizes. A variable read
  another way, for example through a wrapper, is not listed.
- Some modules under `src/` are built and tested but not reachable from any
  command. [`docs/atlas-os/ARCHITECTURE.md` §C](../../docs/atlas-os/ARCHITECTURE.md)
  lists them.

## Validation

```sh
npm ci --ignore-scripts && npm run build && npm test
```

`npm test` runs a strict TypeScript build and then the Node test suite.
