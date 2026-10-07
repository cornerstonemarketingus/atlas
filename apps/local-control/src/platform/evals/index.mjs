/**
 * Replay and autonomous evaluation over Atlas's real event model: run
 * manifests, side-effect-free replay and fixture re-execution, comparison,
 * versioned benchmark suites and the release gate. See manifest.mjs for the
 * design and replay.mjs for the side-effect guarantee.
 */
export { MANIFEST_VERSION, ManifestError, buildRunManifest, describeTool, verifyManifest } from "./manifest.mjs";
export { compareManifests, safetyOf } from "./compare.mjs";
export { recordedModelClient, replayManifest } from "./replay.mjs";
export { BenchmarkError, SCENARIO_SCHEMA, SUITE_SCHEMA, runScenario, runSuite, summarizeResults, validateSuite } from "./benchmark.mjs";
export { GATE_SCHEMA, GateError, evaluateGate, validateThresholds } from "./gate.mjs";
export { createSandbox } from "./sandbox-tools.mjs";
