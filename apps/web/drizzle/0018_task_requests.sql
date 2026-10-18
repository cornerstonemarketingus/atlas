CREATE TABLE task_requests (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  requested_by TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'completed')),
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, requested_by, request_key),
  CHECK ((state = 'reserved' AND response_status IS NULL AND response_json IS NULL)
      OR (state = 'completed' AND response_status BETWEEN 200 AND 599 AND response_json IS NOT NULL))
);
