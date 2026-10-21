CREATE TABLE task_execution_claims (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(task_id),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  requested_by TEXT NOT NULL,
  run_id INTEGER NOT NULL CHECK (run_id > 0),
  run_attempt INTEGER NOT NULL CHECK (run_attempt > 0),
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
