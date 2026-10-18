/**
 * Compute plane (issue #353): rented GPU jobs that cannot outlive their
 * budget. Only the fake provider exists; a real adapter is pending the
 * owner's choice of provider and monthly cap. See docs/atlas-os/COMPUTE.md.
 */
export { ComputeManager, ComputeError, DEFAULT_IDLE_TIMEOUT_SEC, DEFAULT_MAX_LIFETIME_CAP_SEC } from "./manager.mjs";
export { ComputeLeaseStore, LEASE_STATES } from "./lease-store.mjs";
export { ATLAS_TAG, ComputeProviderError, FakeClock, FakeGpuProvider, PROVIDER_METHODS, assertProvider, microUsdPerSecond } from "./provider.mjs";
export { ComputeRequirementError, GPU_JOB_KINDS, detectRequirements, inferenceVramGb } from "./requirements.mjs";
