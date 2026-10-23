# Coder trace diagnosis

Use the actual saved run artifact, not repeated tool names, to diagnose exhausted call budgets:

With `--audit-log`, the coder now writes redacted events incrementally every
second and drains pending events when the session finishes or throws. A runner
deadline can therefore leave a partial trace. The latest second or an in-flight
write can still be lost; a forcibly interrupted final line may need the existing
truncated-tail reader policy. A missing terminal event means the trace is
incomplete, not that work succeeded. Disk writes are asynchronous and serialized;
a storage failure preserves the confirmed prefix, reports at finalization, and
stops further writes rather than retrying an uncertain append.

```
atlas replay atlas-output/audit.jsonl
atlas replay atlas-output/audit.jsonl --format json
```

New agent traces populate the existing optional `argumentsDigest` field. Replay exposes a validated `hmac-sha256:` fingerprint on each call in text and JSON. Compare **toolId plus argumentsDigest within the same run** to find exact repeated arguments. Object key order is canonicalized recursively; array order remains meaningful. Different arguments remain different even when their field counts match.

Each `run()` generates an unpublished random key, including when the same agent instance is reused. Fingerprints cannot be compared across runs and are not cache keys, approval digests or authorization. Raw arguments and the key are never added to audit metadata. The keyed construction avoids publishing an unkeyed dictionary-testable hash of a low-entropy secret. Replay ignores malformed fingerprints rather than printing arbitrary strings from that field.

Older traces remain readable, including unfinished calls marked `NO RESULT`; missing fingerprints cannot be reconstructed. Do not claim an old exhausted run looped merely because it repeatedly called `read_source`, or claim it was loop-free because argument identity is absent. Retain original artifacts and record any gaps.

This instrumentation does not deduplicate, suppress or retry calls, raise limits, request a final model turn, or change completion/blocked/security verdicts. Recovered validation failures still consume the existing tool-call budget; policy and scope failures remain fatal. Obtain a fresh bounded medium objective, replay it, then choose a cause-driven repair if it actually repeats work or exceeds a suitable session. The successful UUID-document smoke proves only a trivial task.

The optional medium diagnostic objective and 30-day artifact retention proposal is PR #395 and requires configured workflow owner review. Use the existing authenticated saved-task/claim path; never fabricate a claim or dispatch an unreviewed workflow to avoid that review.
