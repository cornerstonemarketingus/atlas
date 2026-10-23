ALTER TABLE task_outcome_watches ADD COLUMN next_check_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_outcome_observations ADD COLUMN reason TEXT CHECK (reason IN ('rate_limit', 'authentication', 'permission', 'not_found', 'unavailable'));
ALTER TABLE task_outcome_observations ADD COLUMN retry_at INTEGER;
CREATE TABLE task_observer_provider_state (
  provider TEXT PRIMARY KEY NOT NULL CHECK (provider = 'github-actions'),
  category TEXT NOT NULL CHECK (category IN ('rate_limit', 'authentication', 'permission', 'unavailable')),
  retry_at INTEGER NOT NULL,
  failures INTEGER NOT NULL CHECK (failures BETWEEN 0 AND 8),
  updated_at INTEGER NOT NULL
);
