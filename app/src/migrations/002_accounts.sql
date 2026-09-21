-- Single-use links for "forgot password" and admin invites / resets.
CREATE TABLE password_tokens (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('reset', 'invite')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_tokens_user ON password_tokens (user_id);

-- Optional morning summary email.
ALTER TABLE users
  ADD COLUMN digest_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN last_digest_on date;
