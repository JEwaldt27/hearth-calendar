-- Private subscribe links so phones can show Hearth calendars (read-only).
-- calendar_id NULL = "all my calendars" in one feed.
CREATE TABLE feed_tokens (
  token        text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  calendar_id  uuid REFERENCES calendars ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE NULLS NOT DISTINCT (user_id, calendar_id)
);

-- Browser push subscriptions, one per device.
CREATE TABLE push_subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  endpoint         text NOT NULL UNIQUE,
  p256dh           text NOT NULL,
  auth             text NOT NULL,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_success_at  timestamptz
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- Which reminders were already sent, so each goes out once.
CREATE TABLE reminder_log (
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  key      text NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Reminder preferences (only used once a device has turned on notifications).
ALTER TABLE users
  ADD COLUMN remind_minutes integer NOT NULL DEFAULT 15,
  ADD COLUMN remind_all_day boolean NOT NULL DEFAULT true,
  ADD COLUMN remind_chores_hour integer;
