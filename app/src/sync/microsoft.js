import { DateTime } from 'luxon';
import {
  addExdate,
  addOverride,
  applyFields,
  createResource,
  ensureTimezones,
  findMaster,
  isZone,
  parseIcs,
  rowFromComponent,
} from '../calendar/ical.js';
import { occurrenceStarts } from '../calendar/recurrence.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { decrypt, encrypt, httpError } from '../lib/security.js';

/*
 * Outlook.com / Microsoft 365 calendars through Microsoft Graph.
 *
 * Graph has no CalDAV, so each series (or single event) is turned into an iCalendar resource
 * on sync: the series master becomes the RRULE event, changed occurrences become overrides and
 * occurrences deleted in Outlook become EXDATEs. Writes go the other way. The resource href is
 * the Graph event id and the etag is Graph's @odata.etag.
 */

const SCOPES = 'offline_access User.Read Calendars.ReadWrite';
const TIMEOUT = 30000;
const DAY = 86400000;
// Stores Hearth's countdown flag on the Outlook event.
const COUNTDOWN_PROP = 'String {7f0c4e2a-5b1d-4c3e-9a6f-2d8b1e0c9f37} Name HearthCountdown';
const EVENT_FIELDS = 'id,iCalUId,subject,body,location,start,end,isAllDay,type,recurrence,isCancelled,seriesMasterId,originalStart';
const EXPAND = `singleValueExtendedProperties($filter=id eq '${COUNTDOWN_PROP}')`;

const ms = config.microsoft;
const oauthUrl = (endpoint) => `${ms.loginBase}/${encodeURIComponent(ms.tenant)}/oauth2/v2.0/${endpoint}`;

// --- Sign-in -------------------------------------------------------------------------

export function authorizationUrl(state) {
  const params = new URLSearchParams({
    client_id: ms.clientId,
    response_type: 'code',
    redirect_uri: ms.redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    prompt: 'select_account',
    state,
  });
  return `${oauthUrl('authorize')}?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(oauthUrl('token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ms.clientId, client_secret: ms.clientSecret, scope: SCOPES, ...body }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `Microsoft sign-in failed: ${json.error_description?.split('\r\n')[0] || json.error?.message || (typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)}`);
  return json;
}

export async function exchangeCode(code) {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: ms.redirectUri });
  if (!tokens.refresh_token) throw httpError(502, 'Microsoft did not return a refresh token. Check that the app registration allows offline_access.');
  const res = await fetch(`${ms.graphBase}/me?$select=mail,userPrincipalName,displayName`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(20000),
  });
  const me = await res.json().catch(() => ({}));
  return {
    email: me.mail || me.userPrincipalName || me.displayName || 'Microsoft account',
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: new Date(Date.now() + (tokens.expires_in - 60) * 1000),
  };
}

async function accessToken(account) {
  if (account.access_token_enc && account.access_token_expires && new Date(account.access_token_expires) > new Date()) {
    return decrypt(account.access_token_enc);
  }
  const tokens = await tokenRequest({ refresh_token: decrypt(account.secret_enc), grant_type: 'refresh_token' }).catch((err) => {
    throw httpError(502, `${err.message}. Unlink and link the Microsoft account again in Settings → Linked accounts.`);
  });
  const expires = new Date(Date.now() + (tokens.expires_in - 60) * 1000);
  // Microsoft rotates refresh tokens; keep the newest one.
  const refresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : account.secret_enc;
  await query('UPDATE accounts SET secret_enc = $1, access_token_enc = $2, access_token_expires = $3 WHERE id = $4', [
    refresh,
    encrypt(tokens.access_token),
    expires,
    account.id,
  ]);
  Object.assign(account, { secret_enc: refresh, access_token_enc: encrypt(tokens.access_token), access_token_expires: expires });
  return tokens.access_token;
}

export async function saveMicrosoftAccount(userId, result) {
  const existing = await one(`SELECT id FROM accounts WHERE user_id = $1 AND provider = 'microsoft' AND label = $2`, [userId, result.email]);
  if (existing) {
    await query('UPDATE accounts SET secret_enc = $1, access_token_enc = $2, access_token_expires = $3 WHERE id = $4', [
      encrypt(result.refreshToken),
      encrypt(result.accessToken),
      result.expiresAt,
      existing.id,
    ]);
    return existing.id;
  }
  const row = await one(
    `INSERT INTO accounts (user_id, provider, label, secret_enc, access_token_enc, access_token_expires)
     VALUES ($1, 'microsoft', $2, $3, $4, $5) RETURNING id`,
    [userId, result.email, encrypt(result.refreshToken), encrypt(result.accessToken), result.expiresAt],
  );
  return row.id;
}

// --- Graph requests ------------------------------------------------------------------

async function loadAccount(accountId) {
  const account = await one('SELECT * FROM accounts WHERE id = $1', [accountId]);
  if (!account) throw httpError(400, 'The linked account for this calendar no longer exists.');
  return account;
}

async function graph(account, method, path, { body, etag, allow404 = false } = {}) {
  const url = path.startsWith('http') ? path : `${ms.graphBase}${path}`;
  // Only ever send the token to Graph itself (paging links come from the response).
  if (!url.startsWith(`${ms.graphBase}/`)) throw httpError(502, 'Unexpected Microsoft Graph address.');
  const headers = {
    authorization: `Bearer ${await accessToken(account)}`,
    prefer: `outlook.timezone="${config.defaultTimezone}", outlook.body-content-type="text"`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (etag) headers['if-match'] = etag;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (res.ok) return json;
  if (res.status === 404 && allow404) return null;
  if (res.status === 412) throw httpError(409, 'This event was changed in Outlook. It has been refreshed, so please try again.');
  if (res.status === 401 || res.status === 403) {
    throw httpError(502, `Outlook refused access (${res.status}). Unlink and link the Microsoft account again, or check the calendar isn’t read-only.`);
  }
  if (res.status === 429) throw httpError(502, 'Outlook is limiting requests right now. Try again in a few minutes.');
  throw httpError(502, `Outlook error: ${json.error?.message || `HTTP ${res.status}`}`);
}

async function allPages(account, path) {
  const items = [];
  let next = path;
  for (let page = 0; next; page++) {
    // Never return a partial listing: missing events would look deleted.
    if (page >= 200) throw httpError(502, 'Outlook returned too many events. Lower SYNC_PAST_DAYS / SYNC_FUTURE_DAYS.');
    const json = await graph(account, 'GET', next);
    items.push(...(json.value || []));
    next = json['@odata.nextLink'] || null;
  }
  return items;
}

const calendarPrefix = () => `${ms.graphBase}/me/calendars/`;

export function isMicrosoftCalendarUrl(url) {
  return typeof url === 'string' && url.startsWith(calendarPrefix()) && url.length > calendarPrefix().length;
}

function calendarIdOf(calendar) {
  if (!isMicrosoftCalendarUrl(calendar.remote_url)) throw httpError(400, 'Invalid Outlook calendar.');
  return decodeURIComponent(calendar.remote_url.slice(calendarPrefix().length));
}

const enc = encodeURIComponent;

export async function listMicrosoftCalendars(account) {
  const items = await allPages(account, '/me/calendars?$select=id,name,hexColor,canEdit&$top=100');
  return items.map((c) => ({
    url: `${calendarPrefix()}${enc(c.id)}`,
    name: c.name || 'Calendar',
    color: /^#[0-9a-f]{6}$/i.test(c.hexColor || '') ? c.hexColor : null,
    readOnly: c.canEdit === false,
  }));
}

// --- Graph <-> Hearth fields ---------------------------------------------------------

const DAYS = { sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA' };
const DAY_NAMES = Object.fromEntries(Object.entries(DAYS).map(([name, code]) => [code, name]));
const INDEX = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };
const INDEX_NAMES = Object.fromEntries(Object.entries(INDEX).map(([name, n]) => [n, name]));

const zone = () => config.defaultTimezone;

function zoneOf(tz) {
  return tz && tz !== 'UTC' && isZone(tz) ? tz : tz === 'UTC' ? 'UTC' : zone();
}

function instantOf(dt) {
  return DateTime.fromISO(String(dt.dateTime).slice(0, 19), { zone: zoneOf(dt.timeZone) }).toJSDate();
}

function dayOf(dt) {
  const [y, m, d] = String(dt.dateTime).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** The calendar day nearest to `date` in the household zone, as UTC midnight (how all-day dates are stored). */
function nearestDay(date) {
  let dt = DateTime.fromJSDate(new Date(date), { zone: zone() });
  if (dt.hour >= 12) dt = dt.plus({ days: 1 });
  return Date.UTC(dt.year, dt.month - 1, dt.day);
}

function textOf(body) {
  if (!body?.content) return '';
  if (body.contentType === 'html') {
    return body.content
      .replace(/<br\s*\/?>|<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }
  return body.content.replace(/\r\n/g, '\n').trim();
}

function fieldsFromGraph(ev) {
  const allDay = Boolean(ev.isAllDay);
  const start = allDay ? dayOf(ev.start) : instantOf(ev.start);
  let end = allDay ? dayOf(ev.end) : instantOf(ev.end);
  if (end < start || (allDay && end.getTime() === start.getTime())) end = new Date(start.getTime() + (allDay ? DAY : 0));
  const countdown = (ev.singleValueExtendedProperties || []).some((p) => String(p.id).toLowerCase() === COUNTDOWN_PROP.toLowerCase() && p.value === '1');
  return {
    title: String(ev.subject || '').slice(0, 500),
    description: textOf(ev.body).slice(0, 10000),
    location: String(ev.location?.displayName || '').slice(0, 500),
    allDay,
    tzid: allDay ? 'UTC' : zone(),
    start,
    end,
    countdown,
  };
}

/** Graph patternedRecurrence -> RRULE, or null when Outlook uses a pattern Hearth can't express. */
export function graphToRrule(recurrence, allDay) {
  const p = recurrence?.pattern;
  const r = recurrence?.range;
  if (!p) return null;
  const parts = [];
  const days = (p.daysOfWeek || []).map((d) => DAYS[String(d).toLowerCase()]).filter(Boolean);
  const index = INDEX[String(p.index || 'first').toLowerCase()];
  switch (p.type) {
    case 'daily':
      parts.push('FREQ=DAILY');
      break;
    case 'weekly':
      parts.push('FREQ=WEEKLY');
      if (days.length) parts.push(`BYDAY=${days.join(',')}`);
      if (p.interval > 1 && DAYS[String(p.firstDayOfWeek || '').toLowerCase()]) parts.push(`WKST=${DAYS[p.firstDayOfWeek.toLowerCase()]}`);
      break;
    case 'absoluteMonthly':
      parts.push('FREQ=MONTHLY', `BYMONTHDAY=${p.dayOfMonth}`);
      break;
    case 'relativeMonthly':
      if (!days.length) return null;
      parts.push('FREQ=MONTHLY', `BYDAY=${days.join(',')}`, `BYSETPOS=${index}`);
      break;
    case 'absoluteYearly':
      parts.push('FREQ=YEARLY', `BYMONTH=${p.month}`, `BYMONTHDAY=${p.dayOfMonth}`);
      break;
    case 'relativeYearly':
      if (!days.length) return null;
      parts.push('FREQ=YEARLY', `BYMONTH=${p.month}`, `BYDAY=${days.join(',')}`, `BYSETPOS=${index}`);
      break;
    default:
      return null;
  }
  if (p.interval > 1) parts.splice(1, 0, `INTERVAL=${p.interval}`);
  if (r?.type === 'numbered' && r.numberOfOccurrences > 0) parts.push(`COUNT=${r.numberOfOccurrences}`);
  else if (r?.type === 'endDate' && r.endDate) {
    const until = allDay
      ? r.endDate.replace(/-/g, '')
      : DateTime.fromISO(r.endDate, { zone: zone() }).endOf('day').toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
    parts.push(`UNTIL=${until}`);
  }
  return parts.join(';');
}

function unsupported() {
  return httpError(400, 'Outlook can’t store this repeat pattern. Choose daily, weekly, monthly or yearly.');
}

/** RRULE -> Graph patternedRecurrence for a series starting at `row.start_at`. */
export function rruleToGraph(rrule, row, tz) {
  const parts = Object.fromEntries(
    String(rrule)
      .replace(/^RRULE:/i, '')
      .split(';')
      .filter(Boolean)
      .map((kv) => kv.split('=')),
  );
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'COUNT', 'UNTIL', 'WKST']);
  if (Object.keys(parts).some((k) => !known.has(k))) throw unsupported();

  const start = row.all_day ? DateTime.fromJSDate(row.start_at, { zone: 'UTC' }) : DateTime.fromJSDate(row.start_at, { zone: tz });
  const interval = Math.max(1, Number(parts.INTERVAL || 1));
  let index = parts.BYSETPOS ? Number(parts.BYSETPOS) : null;
  const days = [];
  for (const token of (parts.BYDAY || '').split(',').filter(Boolean)) {
    const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
    if (!m) throw unsupported();
    if (m[1]) {
      if (index !== null && index !== Number(m[1])) throw unsupported();
      index = Number(m[1]);
    }
    days.push(DAY_NAMES[m[2]]);
  }
  const startDay = DAY_NAMES[['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][start.weekday - 1]];
  const monthDay = parts.BYMONTHDAY ? Number(parts.BYMONTHDAY) : start.day;
  if (monthDay < 1 || String(parts.BYMONTHDAY || '').includes(',')) throw unsupported();
  if (index !== null && !INDEX_NAMES[index]) throw unsupported();

  let pattern;
  switch (parts.FREQ) {
    case 'DAILY':
      if (days.length) throw unsupported();
      pattern = { type: 'daily', interval };
      break;
    case 'WEEKLY':
      pattern = { type: 'weekly', interval, daysOfWeek: days.length ? days : [startDay], firstDayOfWeek: DAY_NAMES[parts.WKST] || 'sunday' };
      break;
    case 'MONTHLY':
      pattern = days.length
        ? { type: 'relativeMonthly', interval, daysOfWeek: days, index: INDEX_NAMES[index ?? 1] }
        : { type: 'absoluteMonthly', interval, dayOfMonth: monthDay };
      break;
    case 'YEARLY': {
      const month = parts.BYMONTH ? Number(parts.BYMONTH) : start.month;
      if (!(month >= 1 && month <= 12)) throw unsupported();
      pattern = days.length
        ? { type: 'relativeYearly', interval, daysOfWeek: days, index: INDEX_NAMES[index ?? 1], month }
        : { type: 'absoluteYearly', interval, dayOfMonth: monthDay, month };
      break;
    }
    default:
      throw unsupported();
  }

  const range = { type: 'noEnd', startDate: start.toISODate(), recurrenceTimeZone: tz };
  if (parts.COUNT) Object.assign(range, { type: 'numbered', numberOfOccurrences: Number(parts.COUNT) });
  else if (parts.UNTIL) {
    let end;
    if (/^\d{8}$/.test(parts.UNTIL)) end = DateTime.fromFormat(parts.UNTIL, 'yyyyMMdd', { zone: 'UTC' });
    else {
      end = DateTime.fromFormat(parts.UNTIL.replace(/Z$/, ''), "yyyyMMdd'T'HHmmss", { zone: 'UTC' }).setZone(row.all_day ? 'UTC' : tz);
      // Outlook's end date includes that whole day; drop it if UNTIL falls before that day's occurrence.
      if (!row.all_day && end.hour * 60 + end.minute < start.hour * 60 + start.minute) end = end.minus({ days: 1 });
    }
    Object.assign(range, { type: 'endDate', endDate: end.toISODate() });
  }
  return { pattern, range };
}

function eventZone(row) {
  return !row.all_day && row.tzid && row.tzid !== 'UTC' && isZone(row.tzid) ? row.tzid : zone();
}

function toGraphEvent(row) {
  const tz = eventZone(row);
  const at = (d) =>
    row.all_day
      ? { dateTime: `${d.toISOString().slice(0, 10)}T00:00:00`, timeZone: tz }
      : { dateTime: DateTime.fromJSDate(d, { zone: tz }).toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone: tz };
  return {
    subject: row.title || '',
    body: { contentType: 'text', content: row.description || '' },
    location: { displayName: row.location || '' },
    isAllDay: Boolean(row.all_day),
    start: at(row.start_at),
    end: at(row.end_at),
    singleValueExtendedProperties: [{ id: COUNTDOWN_PROP, value: row.countdown ? '1' : '0' }],
  };
}

function recurrenceKey(rec) {
  if (!rec?.pattern) return '';
  const p = rec.pattern;
  const r = rec.range || {};
  return JSON.stringify([
    p.type,
    p.interval || 1,
    [...(p.daysOfWeek || [])].map((d) => d.toLowerCase()).sort(),
    p.type.startsWith('absolute') ? p.dayOfMonth : 0,
    p.type.endsWith('Yearly') ? p.month : 0,
    p.type.startsWith('relative') ? String(p.index || 'first').toLowerCase() : '',
    r.type,
    r.type === 'numbered' ? r.numberOfOccurrences : 0,
    r.type === 'endDate' ? r.endDate : '',
  ]);
}

/** Same start, end and repeat rule? (Changing those on an Outlook series resets its changed occurrences.) */
function sameTiming(current, next) {
  const t = (dt) => (current.isAllDay ? String(dt.dateTime).slice(0, 10) : instantOf(dt).getTime());
  return (
    Boolean(current.isAllDay) === next.isAllDay &&
    t(current.start) === (next.isAllDay ? next.start.dateTime.slice(0, 10) : instantOf(next.start).getTime()) &&
    t(current.end) === (next.isAllDay ? next.end.dateTime.slice(0, 10) : instantOf(next.end).getTime()) &&
    recurrenceKey(current.recurrence) === recurrenceKey(next.recurrence)
  );
}

// --- Sync ----------------------------------------------------------------------------

function listQuery(extra) {
  return new URLSearchParams({ $select: EVENT_FIELDS, $expand: EXPAND, ...extra }).toString();
}

function singleResource(ev) {
  const uid = ev.iCalUId || ev.id;
  return { href: ev.id, etag: ev['@odata.etag'] || null, uid, vcal: createResource(uid, fieldsFromGraph(ev)) };
}

/**
 * Downloads the calendar's events in the sync window and returns them as
 * [{ href, etag, uid, vcal }] resources.
 */
export async function fetchMicrosoftResources(calendar) {
  const account = await loadAccount(calendar.account_id);
  const now = Date.now();
  const from = new Date(now - config.syncPastDays * DAY);
  const to = new Date(now + config.syncFutureDays * DAY);
  const instances = await allPages(
    account,
    `/me/calendars/${enc(calendarIdOf(calendar))}/calendarView?${listQuery({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '500' })}`,
  );

  const resources = [];
  const bySeries = new Map();
  for (const ev of instances) {
    if (ev.isCancelled) continue;
    if (ev.seriesMasterId && ev.type !== 'singleInstance') {
      if (!bySeries.has(ev.seriesMasterId)) bySeries.set(ev.seriesMasterId, []);
      bySeries.get(ev.seriesMasterId).push(ev);
    } else {
      resources.push(singleResource(ev));
    }
  }

  for (const [masterId, list] of bySeries) {
    const master = await graph(account, 'GET', `/me/events/${enc(masterId)}?${new URLSearchParams({ $select: EVENT_FIELDS, $expand: EXPAND })}`, {
      allow404: true,
    });
    if (!master || master.isCancelled) continue;
    const fields = fieldsFromGraph(master);
    fields.rrule = graphToRrule(master.recurrence, fields.allDay);
    if (!fields.rrule) {
      // A pattern Hearth can't repeat itself: keep each occurrence as its own event.
      for (const ev of list) resources.push({ ...singleResource(ev), uid: `${ev.iCalUId || masterId}-${ev.id}` });
      continue;
    }
    const uid = master.iCalUId || master.id;
    const vcal = createResource(uid, fields);
    const masterRow = rowFromComponent(findMaster(vcal), zone());
    const key = (d) => (fields.allDay ? nearestDay(d) : Math.round(new Date(d).getTime() / 60000));
    const present = new Set();
    for (const ev of list) {
      if (!ev.originalStart) continue;
      present.add(key(ev.originalStart));
      if (ev.type === 'exception') {
        const occurrence = fields.allDay ? new Date(nearestDay(ev.originalStart)) : new Date(ev.originalStart);
        applyFields(addOverride(vcal, occurrence, zone()), fieldsFromGraph(ev));
      }
    }
    // Occurrences Outlook no longer lists were deleted there. Stay clear of the window edges.
    for (const occurrence of occurrenceStarts(masterRow, new Date(from.getTime() + 2 * DAY), new Date(to.getTime() - 2 * DAY), 4000)) {
      if (!present.has(key(occurrence))) addExdate(vcal, occurrence, zone());
    }
    resources.push({ href: master.id, etag: master['@odata.etag'] || null, uid, vcal });
  }

  for (const r of resources) ensureTimezones(r.vcal);
  return resources;
}

// --- Writes --------------------------------------------------------------------------

async function applyOccurrenceChanges(account, eventId, master, overrides) {
  const dates = [...master.exdates, ...overrides.map((o) => o.recurrence_id)].map((d) => new Date(d).getTime());
  const params = new URLSearchParams({
    startDateTime: new Date(Math.min(...dates) - 2 * DAY).toISOString(),
    endDateTime: new Date(Math.max(...dates) + 2 * DAY).toISOString(),
    $select: 'id,originalStart,start,end,subject,body,location,isAllDay',
    $top: '500',
  });
  const instances = await allPages(account, `/me/events/${enc(eventId)}/instances?${params}`);
  const key = (d) => (master.all_day ? nearestDay(d) : Math.round(new Date(d).getTime() / 60000));
  const byStart = new Map(instances.filter((i) => i.originalStart).map((i) => [key(i.originalStart), i]));

  for (const exdate of master.exdates) {
    const instance = byStart.get(key(exdate));
    if (instance) await graph(account, 'DELETE', `/me/events/${enc(instance.id)}`, { allow404: true });
  }
  for (const override of overrides) {
    const instance = byStart.get(key(override.recurrence_id));
    if (!instance) continue;
    const have = fieldsFromGraph(instance);
    const unchanged =
      have.title === override.title &&
      have.description === (override.description || '').trim() &&
      have.location === (override.location || '') &&
      have.start.getTime() === override.start_at.getTime() &&
      have.end.getTime() === override.end_at.getTime();
    if (!unchanged) await graph(account, 'PATCH', `/me/events/${enc(instance.id)}`, { body: toGraphEvent(override) });
  }
}

/** Creates or updates the Outlook event for an iCalendar resource. Returns { href, etag }. */
export async function putMicrosoftEvent(calendar, { href, etag, ics }) {
  const account = await loadAccount(calendar.account_id);
  const rows = parseIcs(ics)
    .getAllSubcomponents('vevent')
    .map((ve) => rowFromComponent(ve, zone()))
    .filter(Boolean);
  const master = rows.find((r) => !r.recurrence_id) || rows[0];
  const overrides = rows.filter((r) => r !== master && r.recurrence_id);
  for (const o of overrides.filter((o) => o.cancelled)) master.exdates.push(o.recurrence_id);

  const body = toGraphEvent(master);
  body.recurrence = master.rrule ? rruleToGraph(master.rrule, master, eventZone(master)) : null;

  let saved;
  if (!href) {
    saved = await graph(account, 'POST', `/me/calendars/${enc(calendarIdOf(calendar))}/events`, { body });
  } else {
    const current = await graph(account, 'GET', `/me/events/${enc(href)}?$select=id,type,start,end,isAllDay,recurrence`, { allow404: true });
    if (!current) throw httpError(409, 'This event was deleted in Outlook. The calendar has been refreshed.');
    if (current.type && current.type !== 'seriesMaster') delete body.recurrence;
    if (sameTiming(current, body)) {
      for (const k of ['start', 'end', 'isAllDay', 'recurrence']) delete body[k];
    }
    saved = await graph(account, 'PATCH', `/me/events/${enc(href)}`, { body, etag });
  }

  if (master.rrule && (master.exdates.length || overrides.some((o) => !o.cancelled))) {
    await applyOccurrenceChanges(account, saved.id, master, overrides.filter((o) => !o.cancelled));
    // Occurrence changes give the series a new etag.
    saved = await graph(account, 'GET', `/me/events/${enc(saved.id)}?$select=id`);
  }
  return { href: saved.id, etag: saved['@odata.etag'] || null };
}

export async function deleteMicrosoftEvent(calendar, { href, etag }) {
  if (!href) return;
  const account = await loadAccount(calendar.account_id);
  await graph(account, 'DELETE', `/me/events/${enc(href)}`, { etag, allow404: true });
}
