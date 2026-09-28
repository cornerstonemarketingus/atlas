# Atlas Runtime v1

Web and API apps use `createAtlas` from `src/atlas.mjs`. `atlas.database`
exposes the validated record store: list/get/create/update/remove/stats.
`atlas.jobs` persists jobs in `data/app.sqlite.jobs` alongside the app database.
Call `atlas.close()` at shutdown. Each app has its own data directory. This
provides local application isolation, not multi-user authentication.

Run `npm run jobs` to enqueue and execute a daily `database.summary` job.
Its persisted result contains record counts. Repeating it on the same UTC
date returns the same job without regenerating the snapshot. The command
runs one ready summary job per invocation and can be called by an external
scheduler. In built output, run `node src/run-jobs.mjs`.

Custom code can call `atlas.jobs.enqueue(kind, payload, {key, maxAttempts,
delayMs})`, `atlas.jobs.get(id)` and `await atlas.jobs.runNext({kind: handler})`.
Only registered handlers run; there is no HTTP job endpoint or arbitrary code
execution. Payloads/results are limited to 64 KiB and attempts to 10. Retry
delays grow from one second to one minute. Exception text is not stored.

Jobs are **at-least-once**. A stopped worker's job becomes eligible after its
lease expires (60 seconds by default). Pass `{leaseMs}` to `runNext` for a
longer handler, up to one hour. There is no heartbeat renewal yet. A handler
may overlap a recovered attempt after lease expiry; use the supplied job
ID as an idempotency key for side effects. A stale attempt cannot overwrite
a newer attempt's saved result. Keep credentials out of payloads and results.

Auth, storage, email, secrets, payments, realtime and analytics adapters are
not included in v1. Generated apps still bind to loopback by default.
