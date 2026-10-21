CREATE TABLE task_outcome_watches (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES task_execution_claims(task_id),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  requested_by TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  request_key TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX task_outcome_watches_active ON task_outcome_watches(enabled, expires_at);
CREATE TABLE task_outcome_observations (
  task_id TEXT NOT NULL REFERENCES task_outcome_watches(task_id),
  tenant_id INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  day INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'observed', 'unconfirmed', 'unavailable')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (task_id, slot)
);
CREATE INDEX task_outcome_observations_day ON task_outcome_observations(day, tenant_id);
CREATE TRIGGER task_outcome_observations_no_delete BEFORE DELETE ON task_outcome_observations
BEGIN SELECT RAISE(ABORT, 'Observation reservations cannot be refunded'); END;
