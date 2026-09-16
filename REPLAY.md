# Replaying a session

Atlas writes an audit trace for every agent run. `atlas replay` reads one back
and reconstructs what the session did.

```
atlas replay atlas-output/audit.jsonl
atlas replay audit.jsonl --session <id> --format json
```

```
Session real-1 — failed
Repository: atlas
Summary: failed

Turn 1 — tool-calls (openai/gpt-oss-120b)
  sent 2 message(s), 41,000 characters, 7 tool(s) offered
  tokens 12,077 in / 480 out
  → repository.search — succeeded (143ms)
  → repository.read_source — NO RESULT

Errors:
  PROVIDER_FAILURE: Groq HTTP 413: request too large

Totals: 1 turn(s), 2 tool call(s) (1 with no result), 12,077 in / 480 out
```

## What it can and cannot show

The trace records **digests, not content** — `contentDigest`,
`argumentsDigest`, `resultDigest`. So a reconstruction recovers the *shape* of
a session: which tools were called in what order, what policy decided, what
failed, how long each step took, where the tokens went. It never recovers the
literal prompt text.

That is deliberate. Traces are redacted and digested precisely so they can be
kept, uploaded as artifacts, and shared without leaking a customer's source or
credentials. A reader that needed the raw text would undo that.

This is also **not re-execution**. Nothing here replays a session against a
model. Re-running a session deterministically would need recorded model
responses, which the trace does not carry.

## Unfinished work stays visible

A turn with no response, and a tool call with no result, are reported as
unfinished rather than dropped. A trace that stops mid-turn is exactly the one
worth reading, and `repository.read_source — NO RESULT` is usually the single
most diagnostic line in it. Dropping incomplete records to keep the output
tidy would throw away the reason someone opened the file.

For the same reason, a half-written final line — what a run killed mid-write
leaves behind — is counted and reported on stderr rather than failing the whole
read.

## Why this exists

One agent's failure is a log you can read top to bottom. Several cooperating
agents produce interleaved traces, and the only question that matters — which
step made the bad decision, and on what evidence — cannot be answered by
scrolling.

Replay is therefore a prerequisite for the multi-agent work, not a companion
to it.
