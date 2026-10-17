-- Existing tasks retain their previous read/status behavior. New requests are
-- persisted before dispatch and never automatically replayed after ambiguity.
ALTER TABLE tasks ADD COLUMN dispatch_state text NOT NULL DEFAULT 'legacy'
  CHECK (dispatch_state IN ('legacy', 'recorded', 'dispatching', 'dispatched', 'unknown', 'rejected'));
