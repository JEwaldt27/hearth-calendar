CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Family members: people (with or without accounts) that calendars and chores belong to.
CREATE TABLE members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name        text NOT NULL,
  color       text NOT NULL,
  emoji       text,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Credentials for two-way linked calendar providers.
CREATE TABLE accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  provider             text NOT NULL CHECK (provider IN ('caldav', 'google')),
  label                text NOT NULL,
  server_url           text,
  username             text,
  secret_enc           text NOT NULL,
  access_token_enc     text,
  access_token_expires timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name            text NOT NULL,
  color           text NOT NULL,
  member_id       uuid REFERENCES members ON DELETE SET NULL,
  source          text NOT NULL CHECK (source IN ('local', 'ics', 'caldav', 'google')),
  account_id      uuid REFERENCES accounts ON DELETE CASCADE,
  remote_url      text,
  ctag            text,
  last_synced_at  timestamptz,
  sync_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendars_owner ON calendars (owner_id);

CREATE TABLE calendar_shares (
  calendar_id uuid NOT NULL REFERENCES calendars ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  permission  text NOT NULL CHECK (permission IN ('view', 'edit')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (calendar_id, user_id)
);
CREATE INDEX calendar_shares_user ON calendar_shares (user_id);

-- Per-user view preferences for any calendar the user can see.
CREATE TABLE calendar_prefs (
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES calendars ON DELETE CASCADE,
  color       text,
  visible     boolean NOT NULL DEFAULT true,
  on_display  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, calendar_id)
);

-- One iCalendar resource (a UID with its recurrence overrides). Source of truth for events.
CREATE TABLE calendar_objects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id uuid NOT NULL REFERENCES calendars ON DELETE CASCADE,
  uid         text NOT NULL,
  href        text,
  etag        text,
  ics         text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_objects_uid ON calendar_objects (calendar_id, uid);
CREATE INDEX calendar_objects_href ON calendar_objects (calendar_id, href);

-- Query index derived from calendar_objects; rebuilt whenever an object changes.
CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id     uuid NOT NULL REFERENCES calendar_objects ON DELETE CASCADE,
  calendar_id   uuid NOT NULL REFERENCES calendars ON DELETE CASCADE,
  recurrence_id timestamptz,
  title         text NOT NULL DEFAULT '',
  description   text,
  location      text,
  start_at      timestamptz NOT NULL,
  end_at        timestamptz NOT NULL,
  all_day       boolean NOT NULL DEFAULT false,
  tzid          text NOT NULL DEFAULT 'UTC',
  rrule         text,
  exdates       timestamptz[] NOT NULL DEFAULT '{}',
  range_end     timestamptz
);
CREATE INDEX events_calendar_start ON events (calendar_id, start_at);
CREATE INDEX events_object ON events (object_id);

CREATE TABLE lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name        text NOT NULL,
  color       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE list_shares (
  list_id     uuid NOT NULL REFERENCES lists ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  permission  text NOT NULL CHECK (permission IN ('view', 'edit')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, user_id)
);

CREATE TABLE list_prefs (
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  list_id     uuid NOT NULL REFERENCES lists ON DELETE CASCADE,
  on_display  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, list_id)
);

CREATE TABLE list_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id       uuid NOT NULL REFERENCES lists ON DELETE CASCADE,
  title         text NOT NULL,
  member_id     uuid REFERENCES members ON DELETE SET NULL,
  due_date      date,
  -- Bitmask of weekdays the chore repeats on (Sun=1, Mon=2 ... Sat=64). NULL = one-off task.
  repeat_days   smallint,
  completed_at  timestamptz,
  completed_by  uuid REFERENCES users ON DELETE SET NULL,
  sort          integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX list_items_list ON list_items (list_id);

CREATE TABLE list_item_completions (
  item_id       uuid NOT NULL REFERENCES list_items ON DELETE CASCADE,
  day           date NOT NULL,
  completed_by  uuid REFERENCES users ON DELETE SET NULL,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, day)
);

-- Wall displays sign in with a long random token instead of a password.
CREATE TABLE displays (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  settings      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);
