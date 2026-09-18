# Local agent runtime

Atlas Local is the persistent, vendor-neutral execution control plane. Tasks and their ordered events survive process restarts in SQLite; a client can disconnect and resume from its last event sequence without replaying the entire session.

## Task lifecycle

`queued -> running -> completed | failed | cancelled`

Tasks found running during startup become `interrupted`. Owners may resume interrupted, failed, or cancelled tasks. Only one in-process runner is permitted per task. Cancellation propagates an `AbortSignal` to the runner and active child process.

## Streaming and reconnect

- `GET /v1/tasks/:id/events?after=<sequence>` returns bounded ordered JSON events.
- `GET /v1/tasks/:id/stream?after=<sequence>` opens an authenticated server-sent event stream and first replays missed events.
- `POST /v1/tasks/:id/cancel` requests cancellation.
- `POST /v1/tasks/:id/resume` creates a fresh attempt for a resumable terminal/interrupted task.

Clients must persist the latest `sequence` they rendered and supply it as `after`. Event payloads are capped at 64 KiB and never contain credentials.

## Tools

`ToolRegistry` registers tools by stable name, capability, risk, timeout, output bound, validator, and executor. Unknown tools and malformed inputs fail closed. The local policy store decides `allow`, `ask`, or `deny`; an `ask` result returns an approval request rather than running the tool. Executors receive an abort signal and must keep credential resolution outside model-visible input.
