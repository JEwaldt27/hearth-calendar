import { calendarQuery, createDAVClient, fetchCalendarObjects, isCollectionDirty } from 'tsdav';
import { config } from '../config.js';
import { one } from '../db.js';
import { assertSafeUrl, decrypt, httpError } from '../lib/security.js';
import { accessToken } from './google.js';

const TIMEOUT = 30000;

export async function loadAccount(accountId) {
  const account = await one('SELECT * FROM accounts WHERE id = $1', [accountId]);
  if (!account) throw httpError(400, 'The linked account for this calendar no longer exists.');
  return account;
}

export async function authHeaders(account) {
  if (account.provider === 'google') return { authorization: `Bearer ${await accessToken(account)}` };
  const basic = Buffer.from(`${account.username}:${decrypt(account.secret_enc)}`).toString('base64');
  return { authorization: `Basic ${basic}` };
}

function displayName(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value._cdata || value._text || '';
  return '';
}

/** Signs in to a CalDAV server and lists its event calendars. */
export async function discoverCaldav({ serverUrl, username, password }) {
  await assertSafeUrl(serverUrl);
  let client;
  try {
    client = await createDAVClient({
      serverUrl,
      credentials: { username, password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      fetchOptions: { signal: AbortSignal.timeout(TIMEOUT) },
    });
  } catch (err) {
    throw httpError(400, `Could not sign in to ${serverUrl}: ${err.message}. Check the server URL, username and app-specific password.`);
  }
  const calendars = await client.fetchCalendars();
  return calendars
    .filter((c) => !c.components || c.components.includes('VEVENT'))
    .map((c) => ({
      url: c.url,
      name: displayName(c.displayName) || 'Calendar',
      color: typeof c.calendarColor === 'string' ? c.calendarColor.slice(0, 7) : null,
      readOnly: false,
    }));
}

function remoteError(res, action) {
  if (res.status === 412) {
    return httpError(409, 'This event was changed in the linked calendar. It has been refreshed, so please try again.');
  }
  if (res.status === 401 || res.status === 403) {
    return httpError(502, `The linked calendar refused to ${action} (${res.status}). The saved credentials may have expired or the calendar is read-only.`);
  }
  return httpError(502, `The linked calendar could not ${action} (HTTP ${res.status}).`);
}

function etagOf(res) {
  return res.headers.get('etag') || null;
}

/** PUT a resource. Returns { href, etag }. */
export async function putResource(calendar, { href, etag, uid, ics }) {
  const account = await loadAccount(calendar.account_id);
  const headers = { ...(await authHeaders(account)), 'content-type': 'text/calendar; charset=utf-8' };
  if (href) {
    if (etag) headers['if-match'] = etag;
  } else {
    headers['if-none-match'] = '*';
  }
  const target = href || new URL(`${encodeURIComponent(uid.replace(/[^\w.@-]/g, '_'))}.ics`, calendar.remote_url).href;
  const res = await fetch(target, { method: 'PUT', headers, body: ics, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw remoteError(res, 'save the event');
  return { href: target, etag: etagOf(res) };
}

export async function deleteResource(calendar, { href, etag }) {
  if (!href) return;
  const account = await loadAccount(calendar.account_id);
  const headers = await authHeaders(account);
  if (etag) headers['if-match'] = etag;
  const res = await fetch(href, { method: 'DELETE', headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok && res.status !== 404 && res.status !== 410) throw remoteError(res, 'delete the event');
}

/** The collection's change tag, or null if the server does not provide one. */
export async function remoteCtag(calendar) {
  const account = await loadAccount(calendar.account_id);
  const { newCtag } = await isCollectionDirty({
    collection: { url: calendar.remote_url },
    headers: await authHeaders(account),
    fetchOptions: { signal: AbortSignal.timeout(TIMEOUT) },
  });
  return newCtag || null;
}

function syncWindow() {
  const now = Date.now();
  return {
    start: new Date(now - config.syncPastDays * 86400000).toISOString(),
    end: new Date(now + config.syncFutureDays * 86400000).toISOString(),
  };
}

function icsStamp(iso) {
  return `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * Lists { href, etag } for every event resource in the sync window, then downloads only
 * the resources whose etag differs from `known` (a Map of href -> etag).
 */
export async function fetchChangedResources(calendar, known) {
  const account = await loadAccount(calendar.account_id);
  const headers = await authHeaders(account);
  const window = syncWindow();
  const collection = new URL(calendar.remote_url).href;

  const listing = await calendarQuery({
    url: collection,
    props: { 'd:getetag': {} },
    filters: [
      {
        'comp-filter': {
          _attributes: { name: 'VCALENDAR' },
          'comp-filter': {
            _attributes: { name: 'VEVENT' },
            'time-range': { _attributes: { start: icsStamp(window.start), end: icsStamp(window.end) } },
          },
        },
      },
    ],
    depth: '1',
    headers,
    fetchOptions: { signal: AbortSignal.timeout(TIMEOUT * 2) },
  }).catch((err) => {
    if (account.provider === 'google' && /\b403\b/.test(err.message)) {
      throw httpError(
        502,
        'Google refused calendar sync (403). Enable the "CalDAV API" in the same Google Cloud project as your OAuth client, wait a few minutes, then press Sync now.',
      );
    }
    throw err;
  });

  const failed = listing.find((r) => r.status === 401 || r.status === 403);
  if (failed) throw httpError(502, `The linked calendar refused access (${failed.status}).`);

  const remote = new Map();
  for (const item of listing) {
    if (!item.href || item.ok === false) continue;
    const href = new URL(item.href, collection).href;
    if (href.replace(/\/$/, '') === collection.replace(/\/$/, '')) continue;
    remote.set(href, item.props?.getetag == null ? null : String(item.props.getetag));
  }

  const changed = [...remote.entries()].filter(([href, etag]) => !etag || known.get(href) !== etag).map(([href]) => href);
  const downloads = [];
  for (let i = 0; i < changed.length; i += 100) {
    const batch = changed.slice(i, i + 100);
    const objects = await fetchCalendarObjects({
      calendar: { url: collection },
      objectUrls: batch.map((u) => new URL(u).pathname + new URL(u).search),
      urlFilter: () => true,
      headers,
      fetchOptions: { signal: AbortSignal.timeout(TIMEOUT * 2) },
    });
    downloads.push(...objects.filter((o) => o.data));
  }
  return { remoteHrefs: new Set(remote.keys()), downloads };
}

/** Downloads a subscribed ICS/webcal feed. */
export async function fetchFeed(rawUrl) {
  let url = String(rawUrl).trim().replace(/^webcals?:\/\//i, 'https://');
  let res;
  // Follow redirects by hand so every hop gets the same address check.
  for (let hop = 0; hop < 5; hop++) {
    await assertSafeUrl(url);
    res = await fetch(url, {
      headers: { accept: 'text/calendar, */*', 'user-agent': 'HearthCalendar/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT * 2),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).href;
      continue;
    }
    break;
  }
  if (!res.ok) throw httpError(502, `The calendar feed returned HTTP ${res.status}.`);
  const text = await res.text();
  if (text.length > 25 * 1024 * 1024) throw httpError(502, 'The calendar feed is too large (over 25 MB).');
  if (!text.includes('BEGIN:VCALENDAR')) throw httpError(502, 'That URL did not return an iCalendar (.ics) feed.');
  return text;
}
