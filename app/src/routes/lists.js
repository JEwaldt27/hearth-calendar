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
    stars: i.stars ?? 1,
    mealSlot: i.meal_slot ?? null,
    notes: i.notes ?? null,
    createdByName: i.created_by_name ?? null,
    completedByName: i.completed_by_name ?? null,
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

const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];

function cleanStars(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10) throw httpError(400, 'Stars must be between 0 and 10.');
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
  const kind = ['checklist', 'meals'].includes(req.body.kind) ? req.body.kind : 'chores';
  const defaultColor = { chores: '#5bb974', checklist: '#f29f3d', meals: '#e56fa5' }[kind];
  const row = await one('INSERT INTO lists (owner_id, name, color, kind) VALUES ($1,$2,$3,$4) RETURNING id', [
    req.user.id, name, cleanColor(req.body.color, defaultColor), kind,
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

function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * All items in visible lists, with completion state for `day` (the viewer's local date).
 * Meal-plan items are limited to mealsFrom..mealsTo (default: yesterday to two weeks ahead).
 */
router.get('/items', requireAuth, async (req, res) => {
  const day = cleanDay(req.query.day) || new Date().toISOString().slice(0, 10);
  const mealsFrom = cleanDay(req.query.mealsFrom) || shiftDay(day, -1);
  const mealsTo = cleanDay(req.query.mealsTo) || shiftDay(day, 14);
  const lists = await listsFor(req.user, req.display || req.query.display === '1');
  const rows = await many(
    `SELECT i.*, c.day IS NOT NULL AS done_on_day, c.completed_at AS done_on_day_at,
            cu.name AS created_by_name,
            CASE WHEN i.repeat_days IS NOT NULL THEN cc.name ELSE iu.name END AS completed_by_name
       FROM list_items i
       JOIN lists l ON l.id = i.list_id
       LEFT JOIN list_item_completions c ON c.item_id = i.id AND c.day = $2
       LEFT JOIN users cu ON cu.id = i.created_by
       LEFT JOIN users iu ON iu.id = i.completed_by
       LEFT JOIN users cc ON cc.id = c.completed_by
      WHERE i.list_id = ANY($1)
        AND ((l.kind = 'meals' AND i.due_date BETWEEN $3 AND $4)
          OR (l.kind <> 'meals' AND (i.repeat_days IS NOT NULL OR i.completed_at IS NULL OR i.completed_at > now() - interval '7 days')))
      ORDER BY i.due_date NULLS FIRST, i.sort, i.created_at`,
    [lists.map((l) => l.id), day, mealsFrom, mealsTo],
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
      `INSERT INTO list_items (list_id, title, created_by, sort)
       VALUES ($1, $2, $3, (SELECT COALESCE(max(sort), 0) + 1 FROM list_items WHERE list_id = $1)) RETURNING *`,
      [list.id, title, req.user.id],
    );
    return res.status(201).json({ item: itemDto({ ...row, created_by_name: req.user.name }) });
  }
  if (list.kind === 'meals') {
    const dueDate = cleanDay(req.body.dueDate);
    if (!dueDate) throw httpError(400, 'Which day is this meal for?');
    const slot = MEAL_SLOTS.includes(req.body.mealSlot) ? req.body.mealSlot : 'dinner';
    const row = await one(
      `INSERT INTO list_items (list_id, title, due_date, meal_slot, notes, created_by, sort)
       VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(max(sort), 0) + 1 FROM list_items WHERE list_id = $1)) RETURNING *`,
      [list.id, title, dueDate, slot, cleanText(req.body.notes, 4000) || null, req.user.id],
    );
    return res.status(201).json({ item: itemDto({ ...row, created_by_name: req.user.name }) });
  }
  const row = await one(
    `INSERT INTO list_items (list_id, title, member_id, due_date, repeat_days, stars, created_by, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(max(sort), 0) + 1 FROM list_items WHERE list_id = $1)) RETURNING *`,
    [
      list.id, title, await memberForList(list, req.body.memberId), cleanDay(req.body.dueDate), cleanRepeat(req.body.repeatDays),
      req.body.stars !== undefined ? cleanStars(req.body.stars) : 1, req.user.id,
    ],
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
    `UPDATE list_items SET list_id = $1, title = $2, member_id = $3, due_date = $4, repeat_days = $5,
            stars = $6, meal_slot = $7, notes = $8
      WHERE id = $9 RETURNING *`,
    [
      listId,
      req.body.title !== undefined ? cleanText(req.body.title, 200) || item.title : item.title,
      req.body.memberId !== undefined ? await memberForList(memberList, req.body.memberId) : listId === item.list_id ? item.member_id : null,
      req.body.dueDate !== undefined ? cleanDay(req.body.dueDate) : item.due_date,
      req.body.repeatDays !== undefined ? cleanRepeat(req.body.repeatDays) : item.repeat_days,
      req.body.stars !== undefined ? cleanStars(req.body.stars) : item.stars,
      req.body.mealSlot !== undefined ? (MEAL_SLOTS.includes(req.body.mealSlot) ? req.body.mealSlot : item.meal_slot) : item.meal_slot,
      req.body.notes !== undefined ? cleanText(req.body.notes, 4000) || null : item.notes,
      item.id,
    ],
  );
  res.json({ item: itemDto(row) });
});

/** Chores assigned to someone earn (or give back) their stars when ticked. */
async function recordStars(list, item, done, day, userId) {
  if (list.kind !== 'chores' || !item.member_id || !item.stars) return;
  if (done) {
    await query(
      `INSERT INTO star_ledger (member_id, delta, reason, item_id, day, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (item_id, day) WHERE item_id IS NOT NULL DO NOTHING`,
      [item.member_id, item.stars, item.title, item.id, day, userId],
    );
  } else if (item.repeat_days) {
    await query('DELETE FROM star_ledger WHERE item_id = $1 AND day = $2', [item.id, day]);
  } else {
    await query('DELETE FROM star_ledger WHERE item_id = $1', [item.id]);
  }
}

router.post('/items/:id/complete', requireAuth, async (req, res) => {
  const { item, list } = await loadItem(req, req.params.id);
  const done = Boolean(req.body.done);
  await recordStars(list, item, done, cleanDay(req.body.day) || new Date().toISOString().slice(0, 10), req.user.id);
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

// --- Staples ("usuals") for checklists ------------------------------------------------

router.get('/lists/:id/staples', requireAuth, async (req, res) => {
  const list = await listAccess(req.user.id, assertUuid(req.params.id, 'list'));
  const rows = await many('SELECT id, title FROM list_staples WHERE list_id = $1 ORDER BY lower(title)', [list.id]);
  res.json({ staples: rows });
});

router.post('/lists/:id/staples', requireAuth, async (req, res) => {
  const list = await editableList(req, req.params.id);
  const titles = (Array.isArray(req.body.titles) ? req.body.titles : [req.body.title]).map((t) => cleanText(t, 200)).filter(Boolean).slice(0, 200);
  if (!titles.length) throw httpError(400, 'Enter an item.');
  for (const title of titles) {
    await query('INSERT INTO list_staples (list_id, title) VALUES ($1, $2) ON CONFLICT (list_id, lower(title)) DO NOTHING', [list.id, title]);
  }
  const rows = await many('SELECT id, title FROM list_staples WHERE list_id = $1 ORDER BY lower(title)', [list.id]);
  res.json({ staples: rows });
});

router.delete('/staples/:id', requireAuth, async (req, res) => {
  const staple = await one('SELECT * FROM list_staples WHERE id = $1', [assertUuid(req.params.id, 'item')]);
  if (!staple) throw httpError(404, 'Not found.');
  await editableList(req, staple.list_id);
  await query('DELETE FROM list_staples WHERE id = $1', [staple.id]);
  res.json({ ok: true });
});

/** Meals cooked before on a meal plan, most recent first, for quick re-use. */
router.get('/lists/:id/meal-history', requireAuth, async (req, res) => {
  const list = await listAccess(req.user.id, assertUuid(req.params.id, 'list'));
  const rows = await many(
    `SELECT * FROM (
       SELECT DISTINCT ON (lower(title)) title, notes, meal_slot, created_at
         FROM list_items WHERE list_id = $1 ORDER BY lower(title), created_at DESC
     ) t ORDER BY created_at DESC LIMIT 200`,
    [list.id],
  );
  res.json({ meals: rows.map((r) => ({ title: r.title, notes: r.notes, mealSlot: r.meal_slot })) });
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
