import { Router } from 'express';
import { WRITABLE_SOURCES } from '../calendar/store.js';
import { config } from '../config.js';
import { many, one, query } from '../db.js';
import { accessibleCalendars, assertUuid, atLeast, calendarAccess, cleanColor, cleanText } from '../lib/access.js';
import { requireAuth, requireUser } from '../lib/auth.js';
import { assertSafeUrl, decrypt, encrypt, httpError, randomToken } from '../lib/security.js';
import { authorizationUrl, exchangeCode, GOOGLE_CALDAV_ROOT, listGoogleCalendars, saveGoogleAccount } from '../sync/google.js';
import { discoverCaldav, fetchFeed } from '../sync/remote.js';
import { syncCalendar } from '../sync/sync.js';
import { mountShares, sharesFor } from './shares.js';

const router = Router();

function calendarDto(c) {
  const isOwner = c.permission === 'owner';
  return {
    id: c.id,
    name: c.name,
    color: c.pref_color || c.color,
    ownerColor: c.color,
    memberId: c.member_id,
    source: c.source,
    permission: c.permission,
    isOwner,
    ownerName: c.owner_name,
    writable: WRITABLE_SOURCES.has(c.source) && atLeast(c.permission, 'edit') && !c.managed,
    managed: c.managed || null,
    visible: c.visible,
    onDisplay: c.on_display,
    feedUrl: isOwner && c.source === 'ics' ? c.remote_url : undefined,
    accountId: isOwner ? c.account_id : undefined,
    accountLabel: isOwner ? c.account_label : undefined,
    lastSyncedAt: c.last_synced_at,
    syncError: c.sync_error,
  };
}

async function calendarsFor(user, display) {
  let rows = await accessibleCalendars(user.id);
  if (display) rows = rows.filter((c) => c.on_display);
  const owned = rows.filter((c) => c.permission === 'owner').map((c) => c.id);
  const shares = await sharesFor('calendar_shares', 'calendar_id', owned);
  return rows.map((c) => ({
    ...calendarDto(c),
    shares: c.permission === 'owner' ? shares.filter((s) => s.resourceId === c.id) : undefined,
  }));
}

async function ownMemberId(userId, memberId) {
  if (!memberId) return null;
  const m = await one('SELECT id FROM members WHERE id = $1 AND owner_id = $2', [assertUuid(memberId, 'member'), userId]);
  if (!m) throw httpError(400, 'Unknown family member.');
  return m.id;
}

router.get('/calendars', requireAuth, async (req, res) => {
  res.json({ calendars: await calendarsFor(req.user, req.display || req.query.display === '1') });
});

router.post('/calendars', requireUser, async (req, res) => {
  const source = req.body.source;
  const name = cleanText(req.body.name, 100);
  if (!name) throw httpError(400, 'Please name the calendar.');
  const color = cleanColor(req.body.color, '#3fa7d6');
  const memberId = await ownMemberId(req.user.id, req.body.memberId);
  let remoteUrl = null;
  let accountId = null;

  if (source === 'ics') {
    remoteUrl = cleanText(req.body.url, 2000);
    await fetchFeed(remoteUrl); // fail fast with a helpful message
  } else if (source === 'caldav' || source === 'google') {
    accountId = assertUuid(req.body.accountId, 'account');
    const account = await one('SELECT * FROM accounts WHERE id = $1 AND user_id = $2', [accountId, req.user.id]);
    if (!account || account.provider !== source) throw httpError(400, 'Unknown linked account.');
    remoteUrl = cleanText(req.body.remoteUrl, 2000);
    if (source === 'google' && !remoteUrl.startsWith(GOOGLE_CALDAV_ROOT)) throw httpError(400, 'Invalid Google calendar.');
    if (source === 'caldav') await assertSafeUrl(remoteUrl);
  } else if (source !== 'local') {
    throw httpError(400, 'Unknown calendar type.');
  }

  const row = await one(
    `INSERT INTO calendars (owner_id, name, color, member_id, source, account_id, remote_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [req.user.id, name, color, memberId, source, accountId, remoteUrl],
  );
  if (source !== 'local') await syncCalendar(row.id, { force: true });
  const calendars = await calendarsFor(req.user, null);
  res.status(201).json({ calendar: calendars.find((c) => c.id === row.id) });
});

router.patch('/calendars/:id', requireUser, async (req, res) => {
  const cal = await calendarAccess(req.user.id, assertUuid(req.params.id, 'calendar'), 'owner');
  const name = req.body.name !== undefined ? cleanText(req.body.name, 100) || cal.name : cal.name;
  const color = req.body.color !== undefined ? cleanColor(req.body.color, cal.color) : cal.color;
  const memberId = req.body.memberId !== undefined ? await ownMemberId(req.user.id, req.body.memberId) : cal.member_id;
  let remoteUrl = cal.remote_url;
  if (cal.source === 'ics' && req.body.url !== undefined && req.body.url !== cal.remote_url) {
    remoteUrl = cleanText(req.body.url, 2000);
    await fetchFeed(remoteUrl);
  }
  await query('UPDATE calendars SET name=$1, color=$2, member_id=$3, remote_url=$4 WHERE id=$5', [name, color, memberId, remoteUrl, cal.id]);
  if (remoteUrl !== cal.remote_url) await syncCalendar(cal.id, { force: true });
  const calendars = await calendarsFor(req.user, null);
  res.json({ calendar: calendars.find((c) => c.id === cal.id) });
});

/** Personal preferences: any user with access can recolour or hide a calendar just for themselves. */
router.put('/calendars/:id/prefs', requireUser, async (req, res) => {
  const cal = await calendarAccess(req.user.id, assertUuid(req.params.id, 'calendar'));
  const current = await one('SELECT * FROM calendar_prefs WHERE user_id = $1 AND calendar_id = $2', [req.user.id, cal.id]);
  const color = req.body.color === null ? null : req.body.color !== undefined ? cleanColor(req.body.color, null) : current?.color ?? null;
  const visible = req.body.visible !== undefined ? Boolean(req.body.visible) : current?.visible ?? true;
  const onDisplay = req.body.onDisplay !== undefined ? Boolean(req.body.onDisplay) : current?.on_display ?? true;
  await query(
    `INSERT INTO calendar_prefs (user_id, calendar_id, color, visible, on_display) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, calendar_id) DO UPDATE SET color = EXCLUDED.color, visible = EXCLUDED.visible, on_display = EXCLUDED.on_display`,
    [req.user.id, cal.id, color, visible, onDisplay],
  );
  res.json({ ok: true });
});

router.delete('/calendars/:id', requireUser, async (req, res) => {
  const cal = await calendarAccess(req.user.id, assertUuid(req.params.id, 'calendar'));
  if (cal.permission === 'owner') {
    await query('DELETE FROM calendars WHERE id = $1', [cal.id]);
  } else {
    await query('DELETE FROM calendar_shares WHERE calendar_id = $1 AND user_id = $2', [cal.id, req.user.id]);
  }
  res.json({ ok: true });
});

router.post('/calendars/:id/sync', requireUser, async (req, res) => {
  const cal = await calendarAccess(req.user.id, assertUuid(req.params.id, 'calendar'));
  const error = await syncCalendar(cal.id, { force: true });
  res.json({ ok: !error, error });
});

mountShares(router, { path: 'calendars', table: 'calendar_shares', column: 'calendar_id', access: calendarAccess, requireUser });

// --- Linked accounts --------------------------------------------------------

function accountDto(a) {
  return { id: a.id, provider: a.provider, label: a.label, serverUrl: a.server_url, username: a.username };
}

router.get('/accounts', requireUser, async (req, res) => {
  const rows = await many('SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at', [req.user.id]);
  res.json({ accounts: rows.map(accountDto), googleEnabled: config.google.enabled });
});

router.post('/accounts/caldav', requireUser, async (req, res) => {
  const serverUrl = cleanText(req.body.serverUrl, 1000);
  const username = cleanText(req.body.username, 254);
  const password = String(req.body.password || '');
  if (!serverUrl || !username || !password) throw httpError(400, 'Server URL, username and password are all required.');
  const calendars = await discoverCaldav({ serverUrl, username, password });
  const label = cleanText(req.body.label, 100) || `${username} (${new URL(serverUrl).hostname})`;
  const row = await one(
    `INSERT INTO accounts (user_id, provider, label, server_url, username, secret_enc)
     VALUES ($1, 'caldav', $2, $3, $4, $5) RETURNING *`,
    [req.user.id, label, serverUrl, username, encrypt(password)],
  );
  res.status(201).json({ account: accountDto(row), calendars: await markLinked(row.id, calendars) });
});

async function markLinked(accountId, calendars) {
  const linked = new Set((await many('SELECT remote_url FROM calendars WHERE account_id = $1', [accountId])).map((r) => r.remote_url));
  return calendars.map((c) => ({ ...c, linked: linked.has(c.url) }));
}

router.get('/accounts/:id/calendars', requireUser, async (req, res) => {
  const account = await one('SELECT * FROM accounts WHERE id = $1 AND user_id = $2', [assertUuid(req.params.id, 'account'), req.user.id]);
  if (!account) throw httpError(404, 'Account not found.');
  const calendars =
    account.provider === 'google'
      ? await listGoogleCalendars(account)
      : await discoverCaldav({ serverUrl: account.server_url, username: account.username, password: decrypt(account.secret_enc) });
  res.json({ account: accountDto(account), calendars: await markLinked(account.id, calendars) });
});

router.delete('/accounts/:id', requireUser, async (req, res) => {
  const { rowCount } = await query('DELETE FROM accounts WHERE id = $1 AND user_id = $2', [assertUuid(req.params.id, 'account'), req.user.id]);
  if (!rowCount) throw httpError(404, 'Account not found.');
  res.json({ ok: true });
});

// --- Google OAuth -----------------------------------------------------------

const oauthStates = new Map();

router.get('/google/start', requireUser, (req, res) => {
  if (!config.google.enabled) throw httpError(400, 'Google is not configured on this server. See the README.');
  const state = randomToken(24);
  oauthStates.set(state, { userId: req.user.id, expires: Date.now() + 10 * 60 * 1000 });
  res.redirect(authorizationUrl(state));
});

router.get('/google/callback', requireUser, async (req, res) => {
  const pending = oauthStates.get(String(req.query.state || ''));
  oauthStates.delete(String(req.query.state || ''));
  for (const [key, value] of oauthStates) if (value.expires < Date.now()) oauthStates.delete(key);
  if (!pending || pending.expires < Date.now() || pending.userId !== req.user.id) {
    return res.redirect('/#settings?error=' + encodeURIComponent('Google sign-in expired. Please try again.'));
  }
  if (req.query.error || !req.query.code) {
    return res.redirect('/#settings?error=' + encodeURIComponent('Google access was not granted.'));
  }
  try {
    const result = await exchangeCode(String(req.query.code));
    const accountId = await saveGoogleAccount(req.user.id, result);
    res.redirect(`/#settings?account=${accountId}`);
  } catch (err) {
    res.redirect('/#settings?error=' + encodeURIComponent(err.message));
  }
});

export default router;
