# Atlas MCP server (stdio)

Atlas can act as a [Model Context Protocol](https://modelcontextprotocol.io)
server, so an MCP client such as Claude Code or Claude Desktop can look up
Atlas tasks and propose new ones. The server lives in
`apps/local-control/src/platform/mcp-server/` and is started by
`main-stdio.mjs`.

This is a separate process from the Atlas daemon (`npm start`). The daemon does
not start it, and it needs no daemon running. It reads and writes the platform
task store (a SQLite file) directly.

Everything below was checked against the code on 2026-10-20. Sources:
`main-stdio.mjs` (launcher and variables), `server.mjs` (protocol and call
pipeline), `tools.mjs` (tools), `stdio.mjs` (transport) and
`../policy.mjs` (authorization).

## Running it

Requires Node.js 22.13 or newer (it uses `node:sqlite`). There are no npm
dependencies to install.

```sh
cd apps/local-control
ATLAS_MCP_DB="$HOME/.atlas/platform.sqlite" \
ATLAS_MCP_TENANT=local \
ATLAS_MCP_USER=owner \
ATLAS_MCP_PERMISSIONS="atlas.status_lookup,atlas.list_tasks,atlas.list_artifacts" \
npm run --silent mcp-server
```

Use `--silent` (or run `node src/platform/mcp-server/main-stdio.mjs` directly).
Without it, npm prints a `> @atlas/local-control mcp-server` banner on stdout.
stdout is the protocol channel, so a client would fail to parse that banner. Node
prints an `ExperimentalWarning` about SQLite on stderr. That is harmless, and
`node --no-warnings` hides it.

The server speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. It exits with
code 0 when stdin closes. It exits with code 2 if a required variable is
missing.

## Environment variables

The launcher decides who the caller is. Nothing in an MCP message can change
that identity.

| Variable | Required | What it does |
|---|---|---|
| `ATLAS_MCP_DB` | yes | Path of the platform task-store SQLite file, opened with `PlatformTaskStore`. **If the file does not exist, it is created empty** (the parent directory must exist). A mistyped path therefore gives you an empty store, not an error. The daemon's own store is `platform.sqlite` in its data directory: `$ATLAS_LOCAL_DATA_DIR`, or `~/.atlas` when that is unset (`src/main.mjs`). The store uses WAL mode, so the daemon and this server can have the file open at once. |
| `ATLAS_MCP_TENANT` | yes | Tenant id for every call. All reads and writes are scoped to it. The local daemon's platform API uses tenant `local`. |
| `ATLAS_MCP_USER` | yes | User id recorded as the owner of tasks this server creates. It also appears in audit events. The daemon's platform API uses `owner`. |
| `ATLAS_MCP_AGENT` | no | Agent id. It is recorded on created tasks and audit events. Policy rules with an `agents` list match against it. Unset means `null`. The id is not checked against any agent registry. |
| `ATLAS_MCP_PERMISSIONS` | no, but see note | Comma-separated permission patterns granted to the caller, for example `atlas.*` or `atlas.status_lookup,atlas.list_tasks`. Patterns match dotted segments: `*` is exactly one segment and `**` is one or more. **Unset or empty grants nothing, and every tool call is denied** (the policy engine denies by default). |
| `ATLAS_MCP_POLICY` | no | Path of a policy JSON document for `PolicyEngine`. The default is `{ "version": "atlas-mcp.default", "rules": [] }`. A file that cannot be read or parsed, or an invalid document, stops the server at startup. |
| `ATLAS_MCP_AUDIT` | no | Path of a JSONL audit log. Each tool call appends one line. Unset means no audit is kept. |

## Tools

`tools/list` returns exactly four tools. Each has an `inputSchema` and an
`outputSchema`. Arguments are validated before policy runs, and results are
validated before they are returned. The annotations are `readOnlyHint`
(true for the `read` tools), `destructiveHint: false` and
`openWorldHint: false`.

| Tool | Risk | Input | Returns |
|---|---|---|---|
| `atlas.status_lookup` | read | `taskId` (1–128 chars, `[A-Za-z0-9_-]`) | One task: id, status, objective, success criteria, parent task id, timestamps. Returns a `NOT_FOUND` error for an unknown task or a task in another tenant. |
| `atlas.list_tasks` | read | optional `status` (a task state), optional `limit` (1–100, default 20) | Newest tasks in the tenant: id, status, objective, timestamps. |
| `atlas.create_task` | low | `objective` (1–4000 chars), `successCriteria` (1–16 strings, up to 1000 chars each), optional `budget` (`toolCalls`, `wallTimeMs`, `inputTokens`, `outputTokens`, `costMicroUsd`, non-negative integers) | Creates the new task in status `proposed`. The store also records a `task.created` event. |
| `atlas.list_artifacts` | read | optional `taskId` | Artifact **metadata only**: id, task id, kind, media type, content digest, verification state, created time. At most 200 items. No artifact content. |

Nothing exposed here can authorize, start, cancel or change the state of a
task. A task proposed over MCP still has to be authorized inside Atlas. The
`initialize` result also states this in its `instructions` field.

Other protocol methods: `initialize` (accepts protocol versions `2025-06-18`
and `2025-03-26`; any other version is answered with `2025-06-18`), `ping`, and
notifications, which get no reply. Resources, prompts and sampling are not
implemented. Any other method returns JSON-RPC `-32601`.

## Client configuration

Use absolute paths. Clients do not start the server from the repository, so
relative paths and `~` are not expanded. The examples grant the read tools only.
Add `atlas.create_task` (or use `atlas.*`) if the client should be able to
propose tasks.

**Claude Code**: add a project-scoped `.mcp.json` at the root of the repository
you work in (or use `claude mcp add`):

```json
{
  "mcpServers": {
    "atlas": {
      "command": "node",
      "args": [
        "--no-warnings",
        "/absolute/path/to/atlas/apps/local-control/src/platform/mcp-server/main-stdio.mjs"
      ],
      "env": {
        "ATLAS_MCP_DB": "/home/you/.atlas/platform.sqlite",
        "ATLAS_MCP_TENANT": "local",
        "ATLAS_MCP_USER": "owner",
        "ATLAS_MCP_AGENT": "claude-code",
        "ATLAS_MCP_PERMISSIONS": "atlas.status_lookup,atlas.list_tasks,atlas.list_artifacts",
        "ATLAS_MCP_AUDIT": "/home/you/.atlas/mcp-audit.jsonl"
      }
    }
  }
}
```

The equivalent command line:

```sh
claude mcp add atlas \
  --env ATLAS_MCP_DB=/home/you/.atlas/platform.sqlite \
  --env ATLAS_MCP_TENANT=local \
  --env ATLAS_MCP_USER=owner \
  --env ATLAS_MCP_PERMISSIONS=atlas.status_lookup,atlas.list_tasks,atlas.list_artifacts \
  -- node --no-warnings /absolute/path/to/atlas/apps/local-control/src/platform/mcp-server/main-stdio.mjs
```

**Claude Desktop**: put the same `mcpServers` object in
`claude_desktop_config.json` (Settings → Developer → Edit Config). On Windows,
escape backslashes in paths, for example
`"C:\\Users\\you\\.atlas\\platform.sqlite"`.

## Security model

- **The launcher is the authentication boundary.** Over stdio there is no
  token. The tenant, user, agent and permissions come from the environment of
  whoever starts the process, and no message can change them
  (`serveStdio` fixes the principal at launch). In practice, anyone who can
  start this process with write access to the SQLite file can act as any
  tenant and user in it. Protect the database file with filesystem
  permissions. The stdio server does not add anything on top of them.
- **Default deny.** Each `tools/call` goes through `PolicyEngine`. A tool runs
  only if a pattern in `ATLAS_MCP_PERMISSIONS` covers its name and no policy
  rule denies it. A `require_approval` decision is treated as a denial, because
  MCP has no approval channel here. An agent's name or role grants nothing.
- **Policy document** (`ATLAS_MCP_POLICY`): `{ "version": "...", "rules": [...] }`.
  Each rule has an `id`, a `tool` or `tools` (permission patterns), and
  optionally `tenants` and `agents` lists. A rule needs either an `effect`
  (`deny` or `require_approval`; `allow` is accepted but grants nothing on its
  own) or a constraint: `allowOrigins` plus `argument` (default `url`), or
  `denyArgumentPatterns: [{ argument, pattern }]`. A matching `deny` always
  wins. Example: deny task creation to one agent:
  `{ "version": "mcp.1", "rules": [{ "id": "no-create", "tool": "atlas.create_task", "agents": ["claude-code"], "effect": "deny" }] }`.
- **Tenant isolation.** Every store query is filtered by `ATLAS_MCP_TENANT`. A
  task in another tenant returns `NOT_FOUND`, the same as a task that does not
  exist.
- **No execution path.** `atlas.create_task` can only produce a `proposed`
  task. The server checks that invariant after the insert.
- **Validated in and out.** Arguments are checked against the input schema
  (unknown properties are rejected). Results are checked against the output
  schema before they are sent. A message larger than 1 MiB is refused. Internal
  errors return generic messages (`TOOL_FAILED`, `Internal error`) rather than
  stack traces.
- **Audit without content.** With `ATLAS_MCP_AUDIT` set, every call (including
  denied ones) appends `{ at, type: "atlas_mcp.call", tenantId, userId, agentId,
  tool, argsDigest, outcome, durationMs, reason?, policyDecisionId?,
  policyVersion?, effect?, outputDigest? }`. Arguments and outputs are stored
  only as SHA-256 digests, never in raw form. If writing the audit line fails,
  the call is not affected, so a broken audit path is silent. The file grows
  without rotation and is created with your default file mode.
- **Results are untrusted text.** Task objectives are free text written by
  whoever created the task, and the client's model reads them. Treat them as
  data, not instructions.

## Tests

- `apps/local-control/tests/platform-mcp-server-stdio-smoke.test.mjs` spawns
  the `mcp-server` script's entry as a bare child process. It then completes
  the `initialize` handshake, sends `notifications/initialized`, lists tools and
  checks one granted call and one denied call, all in raw JSON-RPC, the way an
  external client would.
- `apps/local-control/tests/platform-mcp-server.test.mjs` covers the server
  core, the in-process and child-process stdio paths (through Atlas's own
  `McpGateway`), and the HTTP transport.

## Not wired: HTTP transport

`mcp-server/http.mjs` (`createAtlasMcpHttpServer`) implements Streamable HTTP
on loopback only, with bearer tokens mapped to principals, an Origin check and
sessions bound to tokens. Nothing in the repository starts it: it has no
launcher, no npm script and no daemon route, and only the tests import it. It
is kept as it is. Use the stdio server above.
