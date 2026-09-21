import { Router } from 'express';
import { buildFeed, feedUrl } from '../calendar/feed.js';
import { many, one, query } from '../db.js';
import { assertUuid, calendarAccess } from '../lib/access.js';
import { requireUser } from '../lib/auth.js';
import { randomToken } from '../lib/security.js';

/** Signed-in management of subscribe links (under /api). */
export const feedApi = Router();

async function calendarIdFrom(req) {
  const id = req.body?.calendarId ?? req.query.calendarId ?? null;
  if (!id) return null;
  await calendarAccess(req.user.id, assertUuid(id, 'calendar'));
  return id;
}

feedApi.get('/feeds', requireUser, async (req, res) => {
  const rows = await many('SELECT token, calendar_id FROM feed_tokens WHERE user_id = $1', [req.user.id]);
  res.json({ feeds: rows.map((r) => ({ calendarId: r.calendar_id, url: feedUrl(r.token) })) });
});

/** Returns the existing link for a calendar (or "all calendars"), creating it the first time. */
feedApi.post('/feeds', requireUser, async (req, res) => {
  const calendarId = await calendarIdFrom(req);
  await query(
    `INSERT INTO feed_tokens (token, user_id, calendar_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, calendar_id) DO NOTHING`,
    [randomToken(24), req.user.id, calendarId],
  );
  const row = await one('SELECT token FROM feed_tokens WHERE user_id = $1 AND calendar_id IS NOT DISTINCT FROM $2', [req.user.id, calendarId]);
  res.json({ calendarId, url: feedUrl(row.token) });
});

/** Replaces the link; anything subscribed with the old one stops updating. */
feedApi.post('/feeds/reset', requireUser, async (req, res) => {
  const calendarId = await calendarIdFrom(req);
  const token = randomToken(24);
  await query('DELETE FROM feed_tokens WHERE user_id = $1 AND calendar_id IS NOT DISTINCT FROM $2', [req.user.id, calendarId]);
  await query('INSERT INTO feed_tokens (token, user_id, calendar_id) VALUES ($1, $2, $3)', [token, req.user.id, calendarId]);
  res.json({ calendarId, url: feedUrl(token) });
});

/** Public, token-authenticated feed that phones and calendar apps poll. */
export async function serveFeed(req, res) {
  const token = String(req.params.file || '').replace(/\.ics$/i, '');
  const body = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await buildFeed(token) : null;
  if (!body) return res.status(404).type('text/plain').send('This calendar link is no longer valid.');
  res
    .set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="hearth.ics"',
      'Cache-Control': 'private, max-age=300',
      'X-Robots-Tag': 'noindex',
    })
    .send(body);
}
