-- Lists: meal plans, who added items, chore stars, staples ("usuals")
ALTER TABLE lists DROP CONSTRAINT IF EXISTS lists_kind_check;
ALTER TABLE lists ADD CONSTRAINT lists_kind_check CHECK (kind IN ('chores', 'checklist', 'meals'));

ALTER TABLE list_items
  ADD COLUMN created_by uuid REFERENCES users ON DELETE SET NULL,
  ADD COLUMN stars smallint NOT NULL DEFAULT 1 CHECK (stars BETWEEN 0 AND 10),
  ADD COLUMN meal_slot text CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner', 'snack')),
  ADD COLUMN notes text;
CREATE INDEX list_items_due ON list_items (list_id, due_date);

CREATE TABLE list_staples (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     uuid NOT NULL REFERENCES lists ON DELETE CASCADE,
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX list_staples_title ON list_staples (list_id, lower(title));

CREATE TABLE rewards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  title       text NOT NULL,
  emoji       text,
  cost        integer NOT NULL CHECK (cost > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Every star earned (+) or spent (-). Balance = SUM(delta).
CREATE TABLE star_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid NOT NULL REFERENCES members ON DELETE CASCADE,
  delta       integer NOT NULL,
  reason      text NOT NULL,
  item_id     uuid REFERENCES list_items ON DELETE SET NULL,
  day         date,
  created_by  uuid REFERENCES users ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX star_ledger_item_day ON star_ledger (item_id, day) WHERE item_id IS NOT NULL;
CREATE INDEX star_ledger_member ON star_ledger (member_id, created_at);

-- Calendar: birthdays, countdowns, Outlook, sync health
ALTER TABLE members
  ADD COLUMN birthday date,
  ADD COLUMN birthday_year_known boolean NOT NULL DEFAULT true;

ALTER TABLE calendars
  ADD COLUMN managed text,
  ADD COLUMN sync_failing_since timestamptz;
ALTER TABLE calendars DROP CONSTRAINT IF EXISTS calendars_source_check;
ALTER TABLE calendars ADD CONSTRAINT calendars_source_check CHECK (source IN ('local', 'ics', 'caldav', 'google', 'microsoft'));
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_provider_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_provider_check CHECK (provider IN ('caldav', 'google', 'microsoft'));

ALTER TABLE events ADD COLUMN countdown boolean NOT NULL DEFAULT false;

-- Photo frame for wall displays (stored in the database so backups include them)
CREATE TABLE photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  mime        text NOT NULL,
  width       integer,
  height      integer,
  bytes       integer NOT NULL,
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photos_owner ON photos (owner_id, created_at);
