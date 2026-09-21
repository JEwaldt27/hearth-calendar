import { Router } from 'express';
import { many, one, query } from '../db.js';
import { assertUuid, cleanText } from '../lib/access.js';
import { requireAuth, requireUser } from '../lib/auth.js';
import { httpError, randomToken, sha256 } from '../lib/security.js';

const router = Router();

const VIEWS = ['month', 'week', 'day', 'agenda'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
const THEMES = ['auto', 'light', 'dark'];

function cleanSettings(input = {}, current = {}) {
  const s = { ...defaults(), ...current };
  if (VIEWS.includes(input.view)) s.view = input.view;
  if (THEMES.includes(input.theme)) s.theme = input.theme;
  if (input.showChores !== undefined) s.showChores = Boolean(input.showChores);
  if (input.showLists !== undefined) s.showLists = Boolean(input.showLists);
  if (input.weekStartsOn !== undefined) s.weekStartsOn = Number(input.weekStartsOn) === 1 ? 1 : 0;
  if (input.allowEditing !== undefined) s.allowEditing = Boolean(input.allowEditing);
  for (const key of ['showMeals', 'showWeather', 'showUpNext', 'showCountdowns', 'nightMode', 'photoFrame']) {
    if (input[key] !== undefined) s[key] = Boolean(input[key]);
  }
  if (TIME_RE.test(input.nightStart || '')) s.nightStart = input.nightStart;
  if (TIME_RE.test(input.nightEnd || '')) s.nightEnd = input.nightEnd;
  if (input.photoIdleMinutes !== undefined) s.photoIdleMinutes = clampInt(input.photoIdleMinutes, 1, 120, 5);
  if (input.photoSeconds !== undefined) s.photoSeconds = clampInt(input.photoSeconds, 5, 300, 20);
  return s;
}

function defaults() {
  return {
    view: 'week',
    theme: 'auto',
    showChores: true,
    showLists: false,
    showMeals: false,
    showWeather: true,
    showUpNext: true,
    showCountdowns: true,
    weekStartsOn: 0,
    allowEditing: true,
    nightMode: false,
    nightStart: '22:00',
    nightEnd: '06:00',
    photoFrame: false,
    photoIdleMinutes: 5,
    photoSeconds: 20,
  };
}

function displayDto(d) {
  return { id: d.id, name: d.name, settings: cleanSettings({}, d.settings), createdAt: d.created_at, lastSeenAt: d.last_seen_at };
}

router.get('/displays', requireUser, async (req, res) => {
  const rows = await many('SELECT * FROM displays WHERE user_id = $1 ORDER BY created_at', [req.user.id]);
  res.json({ displays: rows.map(displayDto) });
});

router.post('/displays', requireUser, async (req, res) => {
  const name = cleanText(req.body.name, 80) || 'Wall display';
  const token = randomToken(32);
  const row = await one('INSERT INTO displays (user_id, name, token_hash, settings) VALUES ($1,$2,$3,$4) RETURNING *', [
    req.user.id, name, sha256(token), cleanSettings(req.body.settings),
  ]);
  res.status(201).json({ display: displayDto(row), token });
});

router.patch('/displays/:id', requireUser, async (req, res) => {
  const current = await one('SELECT * FROM displays WHERE id = $1 AND user_id = $2', [assertUuid(req.params.id, 'display'), req.user.id]);
  if (!current) throw httpError(404, 'Display not found.');
  const row = await one('UPDATE displays SET name = $1, settings = $2 WHERE id = $3 RETURNING *', [
    cleanText(req.body.name, 80) || current.name,
    cleanSettings(req.body.settings, current.settings),
    current.id,
  ]);
  res.json({ display: displayDto(row) });
});

router.post('/displays/:id/token', requireUser, async (req, res) => {
  const token = randomToken(32);
  const row = await one('UPDATE displays SET token_hash = $1 WHERE id = $2 AND user_id = $3 RETURNING *', [
    sha256(token), assertUuid(req.params.id, 'display'), req.user.id,
  ]);
  if (!row) throw httpError(404, 'Display not found.');
  res.json({ display: displayDto(row), token });
});

router.delete('/displays/:id', requireUser, async (req, res) => {
  const { rowCount } = await query('DELETE FROM displays WHERE id = $1 AND user_id = $2', [assertUuid(req.params.id, 'display'), req.user.id]);
  if (!rowCount) throw httpError(404, 'Display not found.');
  res.json({ ok: true });
});

/** What the wall display page needs to boot: works with a display token or a normal session. */
router.get('/display/session', requireAuth, (req, res) => {
  res.json({
    userName: req.user.name,
    display: req.display ? { name: req.display.name, settings: cleanSettings({}, req.display.settings) } : null,
    settings: cleanSettings({}, req.display?.settings),
  });
});

export default router;
