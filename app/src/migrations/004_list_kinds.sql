-- Lists are either chore charts (assignees, repeats, due dates) or simple checklists
-- such as groceries, packing or to-dos.
ALTER TABLE lists ADD COLUMN kind text NOT NULL DEFAULT 'chores' CHECK (kind IN ('chores', 'checklist'));

-- Give every existing account a starter grocery list.
INSERT INTO lists (owner_id, name, color, kind)
SELECT id, 'Groceries', '#f29f3d', 'checklist' FROM users;
