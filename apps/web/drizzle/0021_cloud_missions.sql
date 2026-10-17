CREATE TABLE IF NOT EXISTS cloud_missions (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  requested_by TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, requested_by, id)
);
CREATE INDEX IF NOT EXISTS cloud_missions_owner_updated
  ON cloud_missions (tenant_id, requested_by, updated_at DESC);
CREATE TABLE IF NOT EXISTS cloud_mission_events (
  tenant_id INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, requested_by, mission_id, revision),
  FOREIGN KEY (tenant_id, requested_by, mission_id) REFERENCES cloud_missions (tenant_id, requested_by, id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS cloud_mission_events_no_update BEFORE UPDATE ON cloud_mission_events BEGIN SELECT RAISE(ABORT, 'Mission events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS cloud_mission_events_no_delete BEFORE DELETE ON cloud_mission_events BEGIN SELECT RAISE(ABORT, 'Mission events are append-only'); END;
