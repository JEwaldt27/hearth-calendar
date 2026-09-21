import { Router } from 'express';
import { createEvent, deleteEvent, listOccurrences, loadEventForWrite, updateEvent } from '../calendar/store.js';
import { one } from '../db.js';
import { accessibleCalendars, assertUuid, calendarAccess } from '../lib/access.js';
import { requireAuth } from '../lib/auth.js';
import { httpError } from '../lib/security.js';

const router = Router();
const MAX_RANGE = 400 * 86400000;

/** Wall displays may only touch calendars chosen to appear on displays. */
async function writableCalendar(req, calendarId) {
  const calendar = await calendarAccess(req.user.id, assertUuid(calendarId, 'calendar'), 'edit');
  if (req.display) {
    if (req.display.settings?.allowEditing === false) throw httpError(403, 'Editing is turned off for this display.');
    const pref = await one('SELECT on_display FROM calendar_prefs WHERE user_id = $1 AND calendar_id = $2', [req.user.id, calendar.id]);
    if (pref && !pref.on_display) throw httpError(403, 'This calendar is not shown on displays.');
  }
  return calendar;
}

router.get('/events', requireAuth, async (req, res) => {
  const from = new Date(String(req.query.from));
  const to = new Date(String(req.query.to));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw httpError(400, 'Invalid date range.');
  if (to - from > MAX_RANGE) throw httpError(400, 'Date range is too large.');
  let calendars = await accessibleCalendars(req.user.id);
  if (req.display || req.query.display === '1') calendars = calendars.filter((c) => c.on_display);
  res.json({ events: await listOccurrences(calendars.map((c) => c.id), from, to) });
});

router.post('/events', requireAuth, async (req, res) => {
  const calendar = await writableCalendar(req, req.body.calendarId);
  const created = await createEvent(calendar, req.body);
  res.status(201).json({ id: created?.id });
});

router.patch('/events/:id', requireAuth, async (req, res) => {
  const row = await loadEventForWrite(assertUuid(req.params.id, 'event'));
  const calendar = await writableCalendar(req, row.calendar_id);

  if (req.body.calendarId && req.body.calendarId !== row.calendar_id) {
    // Moving between calendars: create a copy in the destination, then remove the original series.
    const target = await writableCalendar(req, req.body.calendarId);
    if (req.body.scope === 'this' && row.rrule) throw httpError(400, 'A single occurrence cannot be moved to another calendar.');
    const created = await createEvent(target, { ...req.body, rrule: req.body.rrule !== undefined ? req.body.rrule : row.rrule });
    await deleteEvent(calendar, row, { scope: 'all' });
    return res.json({ id: created?.id });
  }

  await updateEvent(calendar, row, req.body);
  res.json({ ok: true });
});

router.delete('/events/:id', requireAuth, async (req, res) => {
  const row = await loadEventForWrite(assertUuid(req.params.id, 'event'));
  const calendar = await writableCalendar(req, row.calendar_id);
  await deleteEvent(calendar, row, { scope: req.query.scope === 'this' ? 'this' : 'all', occurrence: req.query.occurrence });
  res.json({ ok: true });
});

export default router;
