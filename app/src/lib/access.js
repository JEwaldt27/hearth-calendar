import { many, one } from '../db.js';
import { httpError } from './security.js';

const RANK = { view: 1, edit: 2, owner: 3 };

export function atLeast(permission, needed) {
  return (RANK[permission] || 0) >= RANK[needed];
}

/** Every calendar the user owns or has been given, with that user's display preferences. */
export function accessibleCalendars(userId) {
  return many(
    `SELECT c.*, u.name AS owner_name,
            CASE WHEN c.owner_id = $1 THEN 'owner' ELSE s.permission END AS permission,
            p.color AS pref_color, COALESCE(p.visible, true) AS visible, COALESCE(p.on_display, true) AS on_display,
            a.label AS account_label
       FROM calendars c
       JOIN users u ON u.id = c.owner_id
       LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = $1
       LEFT JOIN calendar_prefs p ON p.calendar_id = c.id AND p.user_id = $1
       LEFT JOIN accounts a ON a.id = c.account_id
      WHERE c.owner_id = $1 OR s.user_id IS NOT NULL
      ORDER BY (c.owner_id = $1) DESC, c.created_at`,
    [userId],
  );
}

export async function calendarAccess(userId, calendarId, needed = 'view') {
  const row = await one(
    `SELECT c.*, CASE WHEN c.owner_id = $1 THEN 'owner' ELSE s.permission END AS permission
       FROM calendars c
       LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = $1
      WHERE c.id = $2 AND (c.owner_id = $1 OR s.user_id IS NOT NULL)`,
    [userId, calendarId],
  );
  if (!row) throw httpError(404, 'Calendar not found.');
  if (!atLeast(row.permission, needed)) {
    throw httpError(403, needed === 'owner' ? 'Only the calendar owner can do that.' : 'You only have view access to this calendar.');
  }
  return row;
}

export function accessibleLists(userId) {
  return many(
    `SELECT l.*, u.name AS owner_name,
            CASE WHEN l.owner_id = $1 THEN 'owner' ELSE s.permission END AS permission,
            COALESCE(p.on_display, true) AS on_display
       FROM lists l
       JOIN users u ON u.id = l.owner_id
       LEFT JOIN list_shares s ON s.list_id = l.id AND s.user_id = $1
       LEFT JOIN list_prefs p ON p.list_id = l.id AND p.user_id = $1
      WHERE l.owner_id = $1 OR s.user_id IS NOT NULL
      ORDER BY (l.owner_id = $1) DESC, l.created_at`,
    [userId],
  );
}

export async function listAccess(userId, listId, needed = 'view') {
  const row = await one(
    `SELECT l.*, CASE WHEN l.owner_id = $1 THEN 'owner' ELSE s.permission END AS permission
       FROM lists l
       LEFT JOIN list_shares s ON s.list_id = l.id AND s.user_id = $1
      WHERE l.id = $2 AND (l.owner_id = $1 OR s.user_id IS NOT NULL)`,
    [userId, listId],
  );
  if (!row) throw httpError(404, 'List not found.');
  if (!atLeast(row.permission, needed)) {
    throw httpError(403, needed === 'owner' ? 'Only the list owner can do that.' : 'You only have view access to this list.');
  }
  return row;
}

/** Calendars/lists whose owner the caller can see, so member names and colours can be shown. */
export function visibleMembers(userId) {
  return many(
    `SELECT m.*, (m.owner_id = $1) AS mine FROM members m
      WHERE m.owner_id = $1
         OR m.owner_id IN (SELECT c.owner_id FROM calendars c JOIN calendar_shares s ON s.calendar_id = c.id WHERE s.user_id = $1)
         OR m.owner_id IN (SELECT l.owner_id FROM lists l JOIN list_shares s ON s.list_id = l.id WHERE s.user_id = $1)
      ORDER BY (m.owner_id = $1) DESC, m.sort, m.created_at`,
    [userId],
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value, label = 'id') {
  if (!UUID_RE.test(String(value))) throw httpError(404, `Unknown ${label}.`);
  return value;
}

export function isUuid(value) {
  return UUID_RE.test(String(value));
}

export function cleanColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value.toLowerCase() : fallback;
}

export function cleanText(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}
