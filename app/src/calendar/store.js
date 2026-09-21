import crypto from 'node:crypto';
import { config } from '../config.js';
import { many, one, transaction } from '../db.js';
import { httpError } from '../lib/security.js';
import { deleteResource, putResource } from '../sync/remote.js';
import {
  addExdate,
  addOverride,
  applyFields,
  createResource,
  ensureTimezones,
  findMaster,
  findOverride,
  isZone,
  parseIcs,
  removeOverridesAndExdates,
  rowFromComponent,
  rowsFromVcalendar,
} from './ical.js';
import { occurrenceStarts } from './recurrence.js';

const DAY = 86400000;
export const WRITABLE_SOURCES = new Set(['local', 'caldav', 'google']);

/** Replaces the index rows for one object inside an open transaction. */
export async function indexObject(client, calendarId, objectId, vcal) {
  await client.query('DELETE FROM events WHERE object_id = $1', [objectId]);
  const rows = rowsFromVcalendar(vcal, config.defaultTimezone);
  for (const r of rows) {
    await client.query(
      `INSERT INTO events (object_id, calendar_id, recurrence_id, title, description, location,
                           start_at, end_at, all_day, tzid, rrule, exdates, range_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [objectId, calendarId, r.recurrence_id, r.title, r.description, r.location, r.start_at, r.end_at, r.all_day,
        r.tzid, r.rrule, r.exdates, r.range_end],
    );
  }
}

/** Inserts or replaces a stored resource and re-indexes it. */
export async function upsertObject(client, calendarId, { id, uid, href, etag, ics, vcal }) {
  let objectId = id;
  if (objectId) {
    await client.query('UPDATE calendar_objects SET uid=$1, href=$2, etag=$3, ics=$4, updated_at=now() WHERE id=$5', [
      uid, href, etag, ics, objectId,
    ]);
  } else {
    const { rows } = await client.query(
      'INSERT INTO calendar_objects (calendar_id, uid, href, etag, ics) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [calendarId, uid, href, etag, ics],
    );
    objectId = rows[0].id;
  }
  await indexObject(client, calendarId, objectId, vcal || parseIcs(ics));
  return objectId;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function serialize(row, start, isOverride) {
  const duration = new Date(row.end_at) - new Date(row.start_at);
  const end = new Date(start.getTime() + duration);
  return {
    id: `${row.object_id}|${start.toISOString()}`,
    // The resource id stays stable across edits and syncs; index row ids do not.
    eventId: row.object_id,
    calendarId: row.calendar_id,
    title: row.title,
    description: row.description,
    location: row.location,
    allDay: row.all_day,
    start: row.all_day ? isoDay(start) : start.toISOString(),
    end: row.all_day ? isoDay(end) : end.toISOString(),
    tzid: row.tzid,
    rrule: row.rrule,
    recurring: Boolean(row.rrule || isOverride),
    occurrence: isOverride ? new Date(row.recurrence_id).toISOString() : start.toISOString(),
  };
}

/** Expands every event in the given calendars into concrete occurrences overlapping [from, to). */
export async function listOccurrences(calendarIds, from, to) {
  if (calendarIds.length === 0) return [];
  // All-day events are stored at UTC midnight, so widen the window by a day on each side.
  const qFrom = new Date(from.getTime() - DAY);
  const qTo = new Date(to.getTime() + DAY);
  const rows = await many(
    `SELECT * FROM events
      WHERE calendar_id = ANY($1) AND start_at < $3 AND (range_end IS NULL OR range_end >= $2)`,
    [calendarIds, qFrom, qTo],
  );
  const masters = rows.filter((r) => !r.recurrence_id);
  const recurringObjects = masters.filter((r) => r.rrule).map((r) => r.object_id);
  const overrides = recurringObjects.length
    ? await many('SELECT * FROM events WHERE object_id = ANY($1) AND recurrence_id IS NOT NULL', [recurringObjects])
    : [];
  const overridden = new Map();
  for (const o of overrides) {
    if (!overridden.has(o.object_id)) overridden.set(o.object_id, new Set());
    overridden.get(o.object_id).add(new Date(o.recurrence_id).getTime());
  }

  // Timed events must overlap the exact window; all-day events keep the padded window for the client to place.
  const inWindow = (row, start) => {
    if (row.all_day) return true;
    const end = start.getTime() + (new Date(row.end_at) - new Date(row.start_at));
    return start < to && (end > from || start >= from);
  };

  const out = [];
  for (const row of masters) {
    const skip = overridden.get(row.object_id);
    for (const start of occurrenceStarts(row, qFrom, qTo)) {
      if (skip?.has(start.getTime()) || !inWindow(row, start)) continue;
      out.push(serialize(row, start, false));
    }
  }
  const seen = new Set();
  for (const o of [...overrides, ...rows.filter((r) => r.recurrence_id)]) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const start = new Date(o.start_at);
    if (start < qTo && new Date(o.end_at) >= qFrom && inWindow(o, start)) out.push(serialize(o, start, true));
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value, label) {
  if (!DATE_RE.test(String(value))) throw httpError(400, `${label} must be a date (YYYY-MM-DD).`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw httpError(400, `${label} is not a valid date.`);
  return d;
}

function parseInstant(value, label) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw httpError(400, `${label} is not a valid date/time.`);
  return d;
}

function cleanRrule(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const rule = String(value).trim().replace(/^RRULE:/i, '');
  if (!/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Za-z0-9,+\-:]+)*$/.test(rule) || rule.length > 500) {
    throw httpError(400, 'Invalid repeat rule.');
  }
  return rule;
}

/** Validates client input into the shape `applyFields` expects. */
export function validateEventInput(body, { partial = false } = {}) {
  const fields = {};
  if (!partial || body.title !== undefined) {
    fields.title = String(body.title ?? '').trim().slice(0, 500);
    if (!fields.title) throw httpError(400, 'Please give the event a title.');
  }
  if (body.description !== undefined) fields.description = String(body.description ?? '').slice(0, 10000);
  if (body.location !== undefined) fields.location = String(body.location ?? '').slice(0, 500);
  if (!partial || body.start !== undefined) {
    fields.allDay = Boolean(body.allDay);
    if (fields.allDay) {
      fields.start = parseDay(body.start, 'Start');
      fields.end = body.end ? parseDay(body.end, 'End') : new Date(fields.start.getTime() + DAY);
      if (fields.end <= fields.start) fields.end = new Date(fields.start.getTime() + DAY);
      fields.tzid = 'UTC';
    } else {
      fields.start = parseInstant(body.start, 'Start');
      fields.end = body.end ? parseInstant(body.end, 'End') : new Date(fields.start.getTime() + 3600000);
      if (fields.end < fields.start) throw httpError(400, 'The event cannot end before it starts.');
      fields.tzid = isZone(body.tzid) ? body.tzid : config.defaultTimezone;
    }
  }
  fields.rrule = cleanRrule(body.rrule);
  return fields;
}

function assertWritable(calendar) {
  if (!WRITABLE_SOURCES.has(calendar.source)) {
    throw httpError(400, 'Subscribed ICS feeds are read-only. Link the calendar with CalDAV or Google to edit it here.');
  }
}

/** Persists a modified resource: pushes to the linked calendar first, then stores it locally. */
async function saveResource(calendar, object, uid, vcal) {
  ensureTimezones(vcal);
  const ics = vcal.toString();
  let href = object?.href || null;
  let etag = object?.etag || null;
  if (calendar.source !== 'local') {
    try {
      ({ href, etag } = await putResource(calendar, { href, etag, uid, ics }));
    } catch (err) {
      if (err.status === 409) queueSync(calendar.id);
      throw err;
    }
  }
  return transaction((client) => upsertObject(client, calendar.id, { id: object?.id, uid, href, etag, ics, vcal }));
}

let queueSync = () => {};
export function setSyncTrigger(fn) {
  queueSync = fn;
}

export async function createEvent(calendar, body) {
  assertWritable(calendar);
  const fields = validateEventInput(body);
  const uid = `${crypto.randomUUID()}@hearth`;
  const vcal = createResource(uid, fields);
  const objectId = await saveResource(calendar, null, uid, vcal);
  return { id: objectId };
}

/** Loads a stored resource (by the `eventId` the API hands out) plus its series row, if any. */
export async function loadEventForWrite(objectId) {
  const row = await one(
    `SELECT o.id AS obj_id, o.calendar_id, o.uid, o.href, o.etag, o.ics, e.rrule, e.start_at
       FROM calendar_objects o
       LEFT JOIN events e ON e.object_id = o.id AND e.recurrence_id IS NULL
      WHERE o.id = $1`,
    [objectId],
  );
  if (!row) throw httpError(404, 'Event not found. It may have been deleted or changed by a sync.');
  return row;
}

function objectOf(row) {
  return { id: row.obj_id, href: row.href, etag: row.etag };
}

export async function updateEvent(calendar, row, body) {
  assertWritable(calendar);
  const scope = body.scope === 'this' ? 'this' : 'all';
  const fields = validateEventInput(body, { partial: true });
  const vcal = parseIcs(row.ics);
  const master = findMaster(vcal);
  const recurring = Boolean(master?.hasProperty('rrule'));
  const occurrence = body.occurrence ? parseInstant(body.occurrence, 'Occurrence') : row.start_at ? new Date(row.start_at) : null;
  if (!occurrence && scope === 'this') throw httpError(400, 'Which occurrence should be changed?');

  if (scope === 'this' && recurring) {
    delete fields.rrule;
    const target = findOverride(vcal, occurrence, config.defaultTimezone) || addOverride(vcal, occurrence, config.defaultTimezone);
    applyFields(target, fields);
  } else {
    const target =
      master ||
      (occurrence && findOverride(vcal, occurrence, config.defaultTimezone)) ||
      vcal.getFirstSubcomponent('vevent');
    if (fields.start && recurring) {
      const masterRow = rowFromComponent(target, config.defaultTimezone);
      if (fields.allDay === masterRow.all_day) {
        // Shift the whole series by however far the edited occurrence moved from where it was shown.
        const shownStart = body.originalStart
          ? fields.allDay
            ? parseDay(body.originalStart, 'Original start')
            : parseInstant(body.originalStart, 'Original start')
          : occurrence;
        const shift = fields.start.getTime() - shownStart.getTime();
        const length = fields.end.getTime() - fields.start.getTime();
        fields.start = new Date(masterRow.start_at.getTime() + shift);
        fields.end = new Date(fields.start.getTime() + length);
        if (shift !== 0) removeOverridesAndExdates(vcal);
      } else {
        removeOverridesAndExdates(vcal);
      }
    }
    if (fields.rrule === null) removeOverridesAndExdates(vcal);
    applyFields(target, fields);
  }
  await saveResource(calendar, objectOf(row), row.uid, vcal);
}

export async function deleteEvent(calendar, row, { scope, occurrence }) {
  assertWritable(calendar);
  const vcal = parseIcs(row.ics);
  const master = findMaster(vcal);
  const recurring = Boolean(master?.hasProperty('rrule'));

  if (scope === 'this' && recurring) {
    if (!occurrence) throw httpError(400, 'Which occurrence should be deleted?');
    const when = parseInstant(occurrence, 'Occurrence');
    const override = findOverride(vcal, when, config.defaultTimezone);
    if (override) vcal.removeSubcomponent(override);
    addExdate(vcal, when, config.defaultTimezone);
    await saveResource(calendar, objectOf(row), row.uid, vcal);
    return;
  }

  if (calendar.source !== 'local') await deleteResource(calendar, { href: row.href, etag: row.etag });
  await transaction((client) => client.query('DELETE FROM calendar_objects WHERE id = $1', [row.obj_id]));
}
