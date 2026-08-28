INSERT INTO
  user_roles (name)
VALUES
  (':llm')
ON CONFLICT DO NOTHING;

CREATE TABLE llm_chats (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX llm_chats_user_updated_idx
  ON llm_chats (user_id, updated_at DESC);

CREATE TABLE llm_messages (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  chat_id BIGINT NOT NULL REFERENCES llm_chats (id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX llm_messages_chat_created_idx
  ON llm_messages (chat_id, created_at, id);

CREATE TABLE llm_change_proposals (
  id BIGINT PRIMARY KEY DEFAULT id64 (),
  chat_id BIGINT NOT NULL REFERENCES llm_chats (id) ON DELETE CASCADE,
  assistant_message_id BIGINT REFERENCES llm_messages (id) ON DELETE SET NULL,
  title VARCHAR(160) NOT NULL,
  summary TEXT NOT NULL,
  operations JSONB NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'declined', 'revision_requested', 'accepted')),
  review_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX llm_change_proposals_chat_created_idx
  ON llm_change_proposals (chat_id, created_at, id);
