import { Router } from 'express';
import { many, one, query } from '../db.js';
import { accessibleLists, assertUuid, cleanColor, cleanText, listAccess } from '../lib/access.js';
import { requireAuth, requireUser } from '../lib/auth.js';
import { httpError } from '../lib/security.js';
import { mountShares, sharesFor } from './shares.js';

const router = Router();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function listDto(l, shares) {
  return {
    id: l.id,
    name: l.name,
    color: l.color,
    kind: l.kind,
    permission: l.permission,
    isOwner: l.permission === 'owner',
    ownerName: l.owner_name,
    ownerId: l.owner_id,
    onDisplay: l.on_display,
    shares: l.permission === 'owner' ? shares.filter((s) => s.resourceId === l.id) : undefined,
  };
}

async function listsFor(user, display) {
  let rows = await accessibleLists(user.id);
  if (display) rows = rows.filter((l) => l.on_display);
  const shares = await sharesFor('list_shares', 'list_id', rows.filter((l) => l.permission === 'owner').map((l) => l.id));
  return rows.map((l) => listDto(l, shares));
}

function itemDto(i) {
  return {
    id: i.id,
    listId: i.list_id,
    title: i.title,
    memberId: i.member_id,
    dueDate: i.due_date,
    repeatDays: i.repeat_days,
    done: i.repeat_days ? Boolean(i.done_on_day) : Boolean(i.completed_at),
    completedAt: i.repeat_days ? i.done_on_day_at : i.completed_at,
    sort: i.sort,
  };
}

/** Members assigned to a chore must belong to the list owner. */
async function memberForList(list, memberId) {
  if (!memberId) return null;
  const m = await one('SELECT id FROM members WHERE id = $1 AND owner_id = $2', [assertUuid(memberId, 'member'), list.owner_id]);
  if (!m) throw httpError(400, "That person is not in this list owner's family members.");
  return m.id;
}

function cleanRepeat(value) {
  if (value === null || value === undefined || value === '' || Number(value) === 0) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 127) throw httpError(400, 'Invalid repeat days.');
  return n;
}

function cleanDay(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!DAY_RE.test(String(value))) throw httpError(400, 'Dates must be YYYY-MM-DD.');
  return value;
}

async function editableList(req, listId) {
  const list = await listAccess(req.user.id, assertUuid(listId, 'list'), 'edit');
  if (req.display) {
    const pref = await one('SELECT on_display FROM list_prefs WHERE user_id = $1 AND list_id = $2', [req.user.id, list.id]);
    if (pref && !pref.on_display) throw httpError(403, 'This list is not shown on displays.');
  }
  return list;
}

router.get('/lists', requireAuth, async (req, res) => {
  res.json({ lists: await listsFor(req.user, req.display || req.query.display === '1') });
});

router.post('/lists', requireUser, async (req, res) => {
  const name = cleanText(req.body.name, 100);
  if (!name) throw httpError(400, 'Please name the list.');
  const kind = req.body.kind === 'checklist' ? 'checklist' : 'chores';
  const row = await one('INSERT INTO lists (owner_id, name, color, kind) VALUES ($1,$2,$3,$4) RETURNING id', [
    req.user.id, name, cleanColor(req.body.color, kind === 'checklist' ? '#f29f3d' : '#5bb974'), kind,
  ]);
  res.status(201).json({ list: (await listsFor(req.user)).find((l) => l.id === row.id) });
});

router.patch('/lists/:id', requireUser, async (req, res) => {
  const list = await listAccess(req.user.id, assertUuid(req.params.id, 'list'), 'owner');
  await query('UPDATE lists SET name = $1, color = $2 WHERE id = $3', [
    req.body.name !== undefined ? cleanText(req.body.name, 100) || list.name : list.name,
    req.body.color !== undefined ? cleanColor(req.body.color, list.color) : list.color,
    list.id,
  ]);
  res.json({ list: (await listsFor(req.user)).find((l) => l.id === list.id) });
});

router.put('/lists/:id/prefs', requireUser, async (req, res) => {
  const list = await listAccess(req.user.id, assertUuid(req.params.id, 'list'));
  await query(
    `INSERT INTO list_prefs (user_id, list_id, on_display) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, list_id) DO UPDATE SET on_display = EXCLUDED.on_display`,
    [req.user.id, list.id, Boolean(req.body.onDisplay)],
  );
  res.json({ ok: true });
});

router.delete('/lists/:id', requireUser, async (req, res) => {
  const list = await listAccess(req.user.id, assertUuid(req.params.id, 'list'));
  if (list.permission === 'owner') await query('DELETE FROM lists WHERE id = $1', [list.id]);
  else await query('DELETE FROM list_shares WHERE list_id = $1 AND user_id = $2', [list.id, req.user.id]);
  res.json({ ok: true });
});

mountShares(router, { path: 'lists', table: 'list_shares', column: 'list_id', access: listAccess, requireUser });

// --- Items ------------------------------------------------------------------

/** All items in visible lists, with completion state for `day` (the viewer's local date). */
router.get('/items', requireAuth, async (req, res) => {
  const day = cleanDay(req.query.day) || new Date().toISOString().slice(0, 10);
  const lists = await listsFor(req.user, req.display || req.query.display === '1');
  const rows = await many(
    `SELECT i.*, c.day IS NOT NULL AS done_on_day, c.completed_at AS done_on_day_at
       FROM list_items i
       LEFT JOIN list_item_completions c ON c.item_id = i.id AND c.day = $2
      WHERE i.list_id = ANY($1)
        AND (i.repeat_days IS NOT NULL OR i.completed_at IS NULL OR i.completed_at > now() - interval '7 days')
      ORDER BY i.sort, i.created_at`,
    [lists.map((l) => l.id), day],
  );
  res.json({ day, items: rows.map(itemDto) });
});

router.post('/lists/:id/items', requireAuth, async (req, res) => {
  const list = await editableList(req, req.params.id);
  const title = cleanText(req.body.title, 200);
  if (!title) throw httpError(400, 'Please enter a task.');
  if (list.kind === 'checklist') {
    // Adding something already on the list (e.g. "milk" twice) reuses it, un-checking it if needed.
    const existing = await one(
      `UPDATE list_items SET completed_at = NULL, completed_by = NULL
        WHERE id = (SELECT id FROM list_items WHERE list_id = $1 AND lower(title) = lower($2) ORDER BY completed_at NULLS FIRST LIMIT 1)
        RETURNING *`,
      [list.id, title],
    );
    if (existing) return res.json({ item: itemDto(existing), existing: true });
    const row = await one(
      `INSERT INTO list_items (list_id, title, sort)
       VALUES ($1, $2, (SELECT COALESCE(max(sort), 0) + 1 FROM list_items WHERE list_id = $1)) RETURNING *`,
      [list.id, title],
    );
    return res.status(201).json({ item: itemDto(row) });
  }
  const row = await one(
    `INSERT INTO list_items (list_id, title, member_id, due_date, repeat_days, sort)
     VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(max(sort), 0) + 1 FROM list_items WHERE list_id = $1)) RETURNING *`,
    [list.id, title, await memberForList(list, req.body.memberId), cleanDay(req.body.dueDate), cleanRepeat(req.body.repeatDays)],
  );
  res.status(201).json({ item: itemDto(row) });
});

async function loadItem(req, id) {
  const item = await one('SELECT * FROM list_items WHERE id = $1', [assertUuid(id, 'item')]);
  if (!item) throw httpError(404, 'Task not found.');
  const list = await editableList(req, item.list_id);
  return { item, list };
}

router.patch('/items/:id', requireAuth, async (req, res) => {
  const { item, list } = await loadItem(req, req.params.id);
  let listId = item.list_id;
  let memberList = list;
  if (req.body.listId && req.body.listId !== item.list_id) {
    memberList = await editableList(req, req.body.listId);
    listId = memberList.id;
  }
  const row = await one(
    `UPDATE list_items SET list_id = $1, title = $2, member_id = $3, due_date = $4, repeat_days = $5 WHERE id = $6 RETURNING *`,
    [
      listId,
      req.body.title !== undefined ? cleanText(req.body.title, 200) || item.title : item.title,
      req.body.memberId !== undefined ? await memberForList(memberList, req.body.memberId) : listId === item.list_id ? item.member_id : null,
      req.body.dueDate !== undefined ? cleanDay(req.body.dueDate) : item.due_date,
      req.body.repeatDays !== undefined ? cleanRepeat(req.body.repeatDays) : item.repeat_days,
      item.id,
    ],
  );
  res.json({ item: itemDto(row) });
});

router.post('/items/:id/complete', requireAuth, async (req, res) => {
  const { item } = await loadItem(req, req.params.id);
  const done = Boolean(req.body.done);
  if (item.repeat_days) {
    const day = cleanDay(req.body.day);
    if (!day) throw httpError(400, 'Which day was this chore done?');
    if (done) {
      await query(
        'INSERT INTO list_item_completions (item_id, day, completed_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [item.id, day, req.user.id],
      );
    } else {
      await query('DELETE FROM list_item_completions WHERE item_id = $1 AND day = $2', [item.id, day]);
    }
  } else {
    await query('UPDATE list_items SET completed_at = $1, completed_by = $2 WHERE id = $3', [
      done ? new Date() : null, done ? req.user.id : null, item.id,
    ]);
  }
  res.json({ ok: true });
});

/** Removes every checked-off one-time item from a list ("Clear checked"). */
router.post('/lists/:id/clear-checked', requireAuth, async (req, res) => {
  const list = await editableList(req, req.params.id);
  const { rowCount } = await query('DELETE FROM list_items WHERE list_id = $1 AND repeat_days IS NULL AND completed_at IS NOT NULL', [list.id]);
  res.json({ ok: true, removed: rowCount });
});

router.delete('/items/:id', requireAuth, async (req, res) => {
  const { item } = await loadItem(req, req.params.id);
  await query('DELETE FROM list_items WHERE id = $1', [item.id]);
  res.json({ ok: true });
});

export default router;
