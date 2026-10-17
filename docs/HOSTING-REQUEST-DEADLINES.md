# Hosting API response deadlines

The shared infrastructure client used by Cloudflare, Vercel and Git hosting now bounds both response headers and body consumption. It returns REQUEST_TIMEOUT after its existing 30-second deadline even if a transport ignores AbortSignal. Caller cancellation returns REQUEST_CANCELLED, aborts the transport and removes the caller's listener. An already-cancelled request is refused before calling the provider. Successful and rejected requests also remove their listeners.

A timeout or cancellation after sending a mutation does not prove the provider stopped it. Error text asks the operator to inspect provider state before retrying. The client never retries requests itself. Existing plan/apply approval behavior and credential headers are preserved.

Five new regressions fail on the original client and pass after the change: stalled headers, stalled response body, cancellation before execution, cancellation during body consumption, and listener cleanup after repeated success/rejection. Together with the existing infrastructure tool/adapter integration tests, 14 tests pass. No live DNS, deployment or credential changes were made. Full local-control suite and daemon journey evidence are recorded in the PR/checkpoint once available.
