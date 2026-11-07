CREATE TABLE user_gaeb_view_preferences (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE document_template_assets (
  id BIGINT PRIMARY KEY DEFAULT id64(),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  object_key TEXT NOT NULL,
  ready BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX document_template_asset_names ON document_template_assets(name) WHERE ready;
