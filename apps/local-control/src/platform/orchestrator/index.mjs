/**
 * Orchestration adapters (blueprint §3, §11, §12, Phase 7).
 *
 * Event delivery is platform/outbox-dispatcher.mjs and in-process child
 * scheduling is agent/mission-scheduler.mjs; neither is duplicated here.
 * These modules add what those lack: durable task-DAG readiness across
 * platform tasks, execution replay with consistency checks, pause/cancel
 * propagation (including into MissionSchedulers and worker sessions),
 * restart recovery with escalation, and the model-driven single-agent loop.
 */
export { OrchestratorStore, OrchestratorError, ESCALATION_SOURCES } from "./store.mjs";
export { TaskDag } from "./dag.mjs";
export { replayExecution, redactValue } from "./replay.mjs";
export { TaskControl } from "./control.mjs";
export { AgentLoop, FINISH_TOOL, ERROR_CLASSES, classifyOutcome } from "./agent-loop.mjs";
