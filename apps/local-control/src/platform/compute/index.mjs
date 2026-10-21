/**
 * Compute plane (issue #353): rented GPU jobs that cannot outlive their
 * budget. Providers: the fake (tests) and RunPod Serverless (off unless an
 * endpoint, key and monthly cap are configured). See docs/atlas-os/COMPUTE.md.
 */
export { ComputeManager, ComputeError, DEFAULT_IDLE_TIMEOUT_SEC, DEFAULT_MAX_LIFETIME_CAP_SEC, monthWindow } from "./manager.mjs";
export { RUNPOD_DEFAULT_PRICING, RUNPOD_PRICING_SOURCE, RunpodProvider, resolveRunpodPricing } from "./runpod.mjs";
export { RUNPOD_API_KEY_NAME, createComputeService, parseMonthlyCapUsd } from "./service.mjs";
export { ComputeLeaseStore, LEASE_STATES } from "./lease-store.mjs";
export { ATLAS_TAG, ComputeProviderError, FakeClock, FakeGpuProvider, PROVIDER_METHODS, assertProvider, microUsdPerSecond } from "./provider.mjs";
export { ComputeRequirementError, GPU_JOB_KINDS, detectRequirements, inferenceVramGb } from "./requirements.mjs";
export { RECENT_LEASES, computeSummary, createComputeRoutes } from "./routes.mjs";
