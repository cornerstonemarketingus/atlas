import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { LocalEnvironment } from "./local.mjs";

/**
 * Genesis projects as persistent environments.
 *
 * - checkpoint: when a build stage starts (and when a project becomes ready)
 *   the project's workspace is snapshotted once per lifecycle transition. The
 *   manifest records the lifecycle state, the plan and task statuses, the
 *   repair count, the last verified check, and the external side effects
 *   that are in flight or done (the ledger in GenesisStore).
 * - restore: the latest snapshot is recreated in a fresh folder next to the
 *   old one and verified against its digests (LocalEnvironment.restore). The
 *   old folder is left untouched for inspection; the project points at the
 *   restored one.
 *
 * The executor owns when these run (executor.mjs); this module only knows how.
 */

/** States whose start is checkpointed: the stage re-runs from its start after a restore. */
export const SNAPSHOT_STATES = Object.freeze(["scaffolding", "building", "verifying", "repairing", "previewing", "reviewing", "ready"]);

export class GenesisEnvironments {
  constructor({ store, tenantId, projectsRoot, snapshotsRoot, runCheck = null, now = () => new Date() }) {
    Object.assign(this, { store, tenantId, projectsRoot, snapshotsRoot, runCheck, now });
  }

  environment(project, folder = project.workspace) {
    return new LocalEnvironment({ id: project.id, folder, root: this.projectsRoot, snapshotsRoot: this.snapshotsRoot, runCheck: this.runCheck, now: this.now });
  }

  manifest(project, transition) {
    const transitions = this.store.transitions(this.tenantId, project.id);
    const checks = [...transitions].reverse().find((t) => t.evidence?.kind === "checks");
    return {
      version: 1,
      projectId: project.id,
      state: project.state,
      transitionSeq: transition.seq,
      plan: project.plan ?? null,
      specVersion: project.spec?.version ?? 1,
      repairsUsed: project.repairsUsed,
      tasks: this.store.tasks(this.tenantId, project.id).map((task) => ({ id: task.id, status: task.status, attempts: task.attempts })),
      lastVerifiedCheck: checks ? { at: checks.at, seq: checks.seq, results: checks.evidence.results ?? [] } : null,
      pendingEffects: this.store.effects(project.id, { status: "in_flight" }).map((effect) => ({ key: effect.key, intent: effect.intent, since: effect.updatedAt })),
      completedEffects: this.store.effects(project.id, { status: "done" }).map((effect) => effect.key),
    };
  }

  /** Snapshots the project's workspace for its current transition (once); null when there is nothing to snapshot. */
  async checkpoint(project) {
    if (!SNAPSHOT_STATES.includes(project.state) || !project.workspace || !existsSync(join(project.workspace, ".git"))) return null;
    const transition = this.store.transitions(this.tenantId, project.id).at(-1);
    const latest = this.store.latestSnapshot(project.id);
    if (latest?.transitionSeq === transition.seq) return latest;
    const snapshot = await this.environment(project).snapshot({ manifest: this.manifest(project, transition), message: `Atlas checkpoint: ${project.state}` });
    return this.store.recordSnapshot(project.id, { state: project.state, transitionSeq: transition.seq, snapshot });
  }

  /** A fresh folder beside the project's folder for a restore. */
  restoreFolder(project, record) {
    const base = basename(project.workspace ?? project.id).replace(/-restored-\d+-[a-z0-9]+$/u, "");
    return join(this.projectsRoot, `${base}-restored-${record.snapshot.seq}-${this.now().getTime().toString(36)}`);
  }

  /** Recreates the latest snapshot in a fresh folder and verifies it; throws EnvironmentError on mismatch. */
  async restoreLatest(project) {
    const record = this.store.latestSnapshot(project.id);
    if (!record) return null;
    const folder = this.restoreFolder(project, record);
    const source = this.environment(project, project.workspace ?? folder);
    const { receipt } = await source.restore(record.snapshot, { folder });
    return { record, receipt };
  }
}
