# Cloud inference response deadlines

Issue #383 extends the existing fixed-origin OpenAI and Workers AI CLI provider. No new inference router, SDK, credentials, destination, workflow or storage is introduced.

## Failure and behavior

The prior provider passed an AbortSignal to fetch but awaited headers, each response-body read, and stream cancellation directly. A transport or body source that ignored cancellation could leave the cloud coder waiting despite its timeout. An already-cancelled direct request could still call a cancellation-ignoring transport.

One deadline now covers acquiring headers and reading the entire bounded response. Every network wait races the same interruption gate; the timer is not reset for incoming chunks. Caller cancellation is terminal and makes no fallback call. A timeout is a retryable provider failure, permitting existing bounded retry and explicitly configured fallback policies to recover. This does not replay agent tools or repository mutations. The four-MiB response cap, fixed vendor destinations, redirect refusal, function-name translation and sanitized provider errors remain in force.

The provider rejects pre-cancelled requests and invalid numeric deadlines before fetch. After interruption it requests cancellation without awaiting transport cooperation, discards late response bodies, releases reader locks where possible, and removes its caller listener and timer. A custom transport that deliberately ignores AbortSignal can still continue its underlying network operation; this boundary guarantees bounded caller waiting, not cancellation of remote billing or external effects.

## Verification

Five new regressions fail when the unchanged provider module is substituted into the compiled test run, and pass with the repair: stalled headers, stalled bodies with never-resolving cancel, pre-cancelled requests, caller cancellation without fallback, and deadline recovery through Workers AI. Successful request cleanup and invalid-deadline checks are also covered. HTTP/provider responses are scripted; no live vendor capacity, paid inference or deployment is established by these tests.

Keep existing task/claim/outcome/mission rollout and isolated-validation work separate. Persistent cloud workspace checkpoints are not added by this repair.

Local validation: TypeScript build passed; 42 focused cloud/retry/fallback/budget tests passed. The full Windows CLI run and existing platform-only failure counts are recorded in the PR; those unchanged line-ending, file-URL and POSIX-mode cases remain separate. The first full test invocation used the repository root instead of the CLI package and produced extra path failures; the corrected package-directory run is the relevant result. No tests were weakened or skipped to obtain a pass.
