CREATE TABLE task_execution_outcomes (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES task_execution_claims(task_id),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  requested_by TEXT NOT NULL,
  run_id INTEGER NOT NULL CHECK (run_id > 0),
  run_attempt INTEGER NOT NULL CHECK (run_attempt > 0),
  job_id INTEGER NOT NULL CHECK (job_id > 0),
  head_sha TEXT NOT NULL,
  conclusion TEXT NOT NULL CHECK (conclusion IN ('success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale', 'startup_failure')),
  completed_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
CREATE TRIGGER task_execution_outcomes_no_update BEFORE UPDATE ON task_execution_outcomes
BEGIN SELECT RAISE(ABORT, 'Execution outcomes are immutable'); END;
CREATE TRIGGER task_execution_outcomes_no_delete BEFORE DELETE ON task_execution_outcomes
BEGIN SELECT RAISE(ABORT, 'Execution outcomes are immutable'); END;
