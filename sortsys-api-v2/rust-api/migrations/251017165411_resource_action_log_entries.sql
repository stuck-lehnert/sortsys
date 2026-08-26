CREATE TABLE resource_action_log_entries (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action TEXT NOT NULL CHECK (action IN ('create', 'modify', 'delete')),
  path TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  session_id TEXT NOT NULL,
  inet_addr TEXT NOT NULL,
  user_agent TEXT NOT NULL
);
