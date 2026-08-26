CREATE TABLE user_visit_history (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  path VARCHAR(512) NOT NULL,
  title VARCHAR(160),
  visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON user_visit_history (user_id);

CREATE INDEX ON user_visit_history (user_id, visited_at DESC);

CREATE TABLE user_action_history (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  action_id VARCHAR(128) NOT NULL,
  label VARCHAR(160) NOT NULL,
  href VARCHAR(512),
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON user_action_history (user_id);

CREATE INDEX ON user_action_history (user_id, used_at DESC);

CREATE INDEX ON user_action_history (user_id, action_id);
