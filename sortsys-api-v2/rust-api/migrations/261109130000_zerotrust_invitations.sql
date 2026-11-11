-- Public invitation proofs only. The invitation secret remains in the URL
-- fragment and in the inviting administrator's encrypted browser record.
CREATE TABLE __zerotrust_invitations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 192),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation BIGINT NOT NULL CHECK (generation > 0),
  invitation JSONB NOT NULL CHECK (jsonb_typeof(invitation) = 'object'),
  expires_at TIMESTAMPTZ NOT NULL,
  claim JSONB CHECK (claim IS NULL OR jsonb_typeof(claim) = 'object'),
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (accepted_at IS NULL OR claim IS NOT NULL),
  CHECK (completed_at IS NULL OR accepted_at IS NOT NULL)
);
CREATE INDEX ON __zerotrust_invitations(user_id, created_at);
