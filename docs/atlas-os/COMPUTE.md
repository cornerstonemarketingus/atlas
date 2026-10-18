# Compute plane: rented GPUs that cannot outlive their budget

Issue #353; engineering plan 2026 §3.2. Code: `apps/local-control/src/platform/compute/`.
Tests: `apps/local-control/tests/compute-manager.test.mjs` and `tests/budget-release.test.mjs`.

**Status:** interface, fake provider and every safety stop are built and tested
against a fake per-second-billing provider with a fake clock. **Real provider
adapter pending owner choice of provider and monthly cap.** Nothing here makes
network calls or spends money, and nothing is wired into `main.mjs` yet.

## Provider interface (`provider.mjs`)

`estimate(job) → { gpuType, estHourlyUsd, estMinutes } | null`,
`provision({ gpuType, maxLifetimeSec, tags }) → instance`, `status(id)`,
`terminate(id)` (idempotent), `listTagged(tag)` (only instances still billing).
An instance reports its integer `billedMicroUsd`. A provider must enforce
`maxLifetimeSec` itself. `FakeGpuProvider` bills every started second and
stops instances at their max lifetime on its own.

## The four stops (`manager.mjs`)

1. **Budget reservation before provisioning.** The worst case (per-second
   rate × max lifetime) is reserved on the job's task through the existing
   `TaskBudget`, so ancestors and siblings see it immediately. The manager
   refuses with no approved `costMicroUsd` limit (`NO_APPROVED_BUDGET`) or
   when the estimate exceeds what is left (`ESTIMATE_EXCEEDS_BUDGET`). Max
   lifetime is trimmed to what the budget covers, never below the estimate.
2. **Provider-side max lifetime**, set at creation, so a crashed Atlas still
   stops billing. The reservation already covers that lifetime. The manager
   also enforces the same deadline itself, in case a provider ignores it.
3. **Idle timeout.** Each `heartbeat()` extends the lease by
   `idleTimeoutSec` (default 300). An expired lease cannot be revived; the
   reconciler terminates its instance and aborts the job's `signal`.
4. **Reconciler.** `reconcile()` ends every lease that is no longer live,
   lists Atlas-tagged instances and terminates any without a live lease, and
   finishes settlements a crash interrupted. `startReconciler()` runs it once
   with `takeover` (leases held by a previous process are ended) and then on
   an interval; `stopReconciler()` stops it.

Jobs run via `runJob({ tenantId, taskId, job, execute, saveOutputs })`.
Outputs are saved while the instance still exists, and the instance is
terminated on success or failure. Requirement detection
(`requirements.mjs`) sets a VRAM floor by kind (render, inference, training,
transcode). It runs locally instead of renting when the machine's own GPU
(from `agent/models/hardware.mjs`) is big enough.

## Leases, settlement and audit

`ComputeLeaseStore` is a tenant-scoped `node:sqlite` table. Each lease records
its job, task, provider, instance id, reservation, lease expiry and deadline.
The lease is written before `provision()`. Every instance carries tags `atlas`,
`atlas-tenant:<id>` and `atlas-lease:<id>`, so an instance created just before
a crash is still found and charged. After termination, the provider's final
bill is settled against the reservation. The unused part goes back through the
new `TaskBudget.release()`, which is idempotent by the lease ref and
understood by `reconcileTaskBudgets`. An overrun is charged truthfully. A bill
that cannot be proven keeps the full reservation charged. Every reserve,
provision, terminate and settle is written to `compute_audit` with an
allowlist of fields; provider error messages are reduced to their codes.

## Known limits

- Cost safety assumes the provider bills at its estimated rate. A real adapter
  must quote the rate it will bill, and its tests must check that.
- With `takeover`, a startup reconcile assumes one daemon per lease database.
- Releasing a reservation after a failed `provision()` trusts the provider's
  tag listing to be current.
- A small window between reserving and writing the lease can leave a
  reservation held after a crash. This is conservative: the budget is held
  and no spend happens.
