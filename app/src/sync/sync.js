import { findMaster, parseIcs, splitFeed } from '../calendar/ical.js';
import { setSyncTrigger, upsertObject } from '../calendar/store.js';
import { config } from '../config.js';
import { many, one, query, transaction } from '../db.js';
import { recordProblem } from '../lib/health.js';
import { fetchMicrosoftResources } from './microsoft.js';
import { fetchChangedResources, fetchFeed, remoteCtag } from './remote.js';

const running = new Map();

async function syncFeed(calendar) {
  const text = await fetchFeed(calendar.remote_url);
  const resources = splitFeed(text);
  const existing = new Map((await many('SELECT id, uid, ics FROM calendar_objects WHERE calendar_id = $1', [calendar.id])).map((o) => [o.uid, o]));
  await transaction(async (client) => {
    const seen = new Set();
    for (const r of resources) {
      seen.add(r.uid);
      const prior = existing.get(r.uid);
      if (prior && prior.ics === r.ics) continue;
      await upsertObject(client, calendar.id, { id: prior?.id, uid: r.uid, href: null, etag: null, ics: r.ics, vcal: r.vcal });
    }
    const gone = [...existing.values()].filter((o) => !seen.has(o.uid)).map((o) => o.id);
    if (gone.length) await client.query('DELETE FROM calendar_objects WHERE id = ANY($1)', [gone]);
  });
}

async function syncDav(calendar, force) {
  let ctag = null;
  try {
    ctag = await remoteCtag(calendar);
    if (!force && ctag && calendar.ctag === ctag) return;
  } catch {
    /* some servers have no ctag support; fall through to a full etag comparison */
  }
  const existing = await many('SELECT id, uid, href, etag FROM calendar_objects WHERE calendar_id = $1', [calendar.id]);
  const byHref = new Map(existing.map((o) => [o.href, o]));
  const { remoteHrefs, downloads } = await fetchChangedResources(calendar, new Map(existing.map((o) => [o.href, o.etag])));

  await transaction(async (client) => {
    for (const d of downloads) {
      let vcal;
      try {
        vcal = parseIcs(d.data);
      } catch {
        continue;
      }
      const ve = findMaster(vcal) || vcal.getFirstSubcomponent('vevent');
      if (!ve) continue;
      const prior = byHref.get(d.url);
      await upsertObject(client, calendar.id, {
        id: prior?.id,
        uid: String(ve.getFirstPropertyValue('uid') || d.url),
        href: d.url,
        etag: d.etag || null,
        ics: d.data,
        vcal,
      });
    }
    const gone = existing.filter((o) => !remoteHrefs.has(o.href)).map((o) => o.id);
    if (gone.length) await client.query('DELETE FROM calendar_objects WHERE id = ANY($1)', [gone]);
    await client.query('UPDATE calendars SET ctag = $1 WHERE id = $2', [ctag, calendar.id]);
  });
}

// Generated resources differ only in these stamps when nothing really changed.
const stable = (ics) => ics.replace(/^(DTSTAMP|LAST-MODIFIED|CREATED|SEQUENCE)[:;].*\r?\n/gm, '');

async function syncMicrosoft(calendar) {
  const resources = await fetchMicrosoftResources(calendar);
  const existing = await many('SELECT id, href, etag, ics FROM calendar_objects WHERE calendar_id = $1', [calendar.id]);
  const byHref = new Map(existing.map((o) => [o.href, o]));
  await transaction(async (client) => {
    const seen = new Set();
    for (const r of resources) {
      seen.add(r.href);
      const prior = byHref.get(r.href);
      const ics = r.vcal.toString();
      if (prior && stable(prior.ics) === stable(ics)) {
        if (prior.etag !== r.etag) await client.query('UPDATE calendar_objects SET etag = $1 WHERE id = $2', [r.etag, prior.id]);
        continue;
      }
      await upsertObject(client, calendar.id, { id: prior?.id, uid: r.uid, href: r.href, etag: r.etag, ics, vcal: r.vcal });
    }
    const gone = existing.filter((o) => !seen.has(o.href)).map((o) => o.id);
    if (gone.length) await client.query('DELETE FROM calendar_objects WHERE id = ANY($1)', [gone]);
  });
}

async function runSync(calendarId, force) {
  const calendar = await one('SELECT * FROM calendars WHERE id = $1', [calendarId]);
  if (!calendar || calendar.source === 'local') return null;
  try {
    if (calendar.source === 'ics') await syncFeed(calendar);
    else if (calendar.source === 'microsoft') await syncMicrosoft(calendar);
    else await syncDav(calendar, force);
    await query('UPDATE calendars SET last_synced_at = now(), sync_error = NULL, sync_failing_since = NULL WHERE id = $1', [calendarId]);
    return null;
  } catch (err) {
    const message = String(err.message || err).slice(0, 500);
    console.warn(`Sync failed for calendar ${calendarId}: ${message}`);
    recordProblem('sync', `${calendar.name}: ${message}`);
    await query(
      'UPDATE calendars SET last_synced_at = now(), sync_error = $1, sync_failing_since = COALESCE(sync_failing_since, now()) WHERE id = $2',
      [message, calendarId],
    );
    return message;
  }
}

/** Syncs one calendar; concurrent requests for the same calendar share a single run. Resolves to an error message or null. */
export function syncCalendar(calendarId, { force = false } = {}) {
  if (running.has(calendarId)) return running.get(calendarId);
  const job = runSync(calendarId, force).finally(() => running.delete(calendarId));
  running.set(calendarId, job);
  return job;
}

setSyncTrigger((calendarId) => {
  syncCalendar(calendarId, { force: true });
});

export function startScheduler() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const due = await many(
        `SELECT id FROM calendars WHERE source <> 'local'
          AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(mins => $1))
          ORDER BY last_synced_at NULLS FIRST`,
        [config.syncIntervalMinutes],
      );
      for (const { id } of due) await syncCalendar(id);
    } catch (err) {
      console.warn('Sync scheduler error:', err.message);
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 60000).unref();
}
