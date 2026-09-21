import crypto from 'node:crypto';
import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { tzlib_get_ical_block } from 'timezones-ical-library';
import { computeRangeEnd } from './recurrence.js';

const DAY = 86400000;

// Outlook/Exchange feeds use Windows zone names.
const WINDOWS_ZONES = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Central America Standard Time': 'America/Guatemala',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'SA Pacific Standard Time': 'America/Bogota',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  UTC: 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kyiv',
  'GTB Standard Time': 'Europe/Bucharest',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'W. Australia Standard Time': 'Australia/Perth',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

const zoneValidity = new Map();

export function isZone(zone) {
  if (!zone || typeof zone !== 'string') return false;
  if (!zoneValidity.has(zone)) zoneValidity.set(zone, DateTime.local().setZone(zone).isValid);
  return zoneValidity.get(zone);
}

export function resolveZone(tzid) {
  if (!tzid) return null;
  const raw = String(tzid).trim().replace(/^"|"$/g, '');
  const candidates = [raw, WINDOWS_ZONES[raw]];
  const suffix = raw.match(/[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/); // e.g. "/mozilla.org/20050126_1/Europe/Berlin"
  if (suffix) candidates.push(suffix[0]);
  return candidates.find((c) => c && c !== 'floating' && isZone(c)) || null;
}

function wallTime(t, zone) {
  return DateTime.fromObject(
    { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
    { zone },
  ).toJSDate();
}

/** Converts an ICAL.Time into { date, allDay, tzid }. Floating times use `fallbackZone`. */
export function convertTime(time, tzParam, fallbackZone) {
  if (time.isDate) return { date: new Date(Date.UTC(time.year, time.month - 1, time.day)), allDay: true, tzid: 'UTC' };
  const zoneId = time.zone && time.zone.tzid;
  if (zoneId === 'UTC' || zoneId === 'Z') {
    return {
      date: new Date(Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second)),
      allDay: false,
      tzid: 'UTC',
    };
  }
  const resolved = resolveZone(tzParam);
  if (resolved) return { date: wallTime(time, resolved), allDay: false, tzid: resolved };
  if (tzParam && zoneId && zoneId !== 'floating') {
    // Unknown zone name, but the file shipped its own VTIMEZONE definition.
    return { date: time.toJSDate(), allDay: false, tzid: 'UTC' };
  }
  const zone = isZone(fallbackZone) ? fallbackZone : 'UTC';
  return { date: wallTime(time, zone), allDay: false, tzid: zone };
}

function convertProp(prop, fallbackZone) {
  return convertTime(prop.getFirstValue(), prop.getParameter('tzid'), fallbackZone);
}

function registerTimezones(vcal) {
  for (const vtz of vcal.getAllSubcomponents('vtimezone')) {
    try {
      const tz = new ICAL.Timezone(vtz);
      if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz);
    } catch {
      /* ignore malformed zone definitions */
    }
  }
}

export function parseIcs(text) {
  const vcal = new ICAL.Component(ICAL.parse(String(text)));
  if (vcal.name !== 'vcalendar') throw new Error('Not an iCalendar file');
  registerTimezones(vcal);
  return vcal;
}

function str(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return max ? s.slice(0, max) : s;
}

function dayFloor(time) {
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

/** Builds the query-index row for one VEVENT. Returns null for unusable components. */
export function rowFromComponent(ve, defaultZone) {
  const dtstartProp = ve.getFirstProperty('dtstart');
  if (!dtstartProp) return null;
  const start = convertProp(dtstartProp, defaultZone);
  const allDay = start.allDay;
  let end;
  const dtendProp = ve.getFirstProperty('dtend');
  if (dtendProp) {
    end = convertProp(dtendProp, start.tzid).date;
  } else {
    const duration = ve.getFirstPropertyValue('duration');
    end = new Date(start.date.getTime() + (duration ? duration.toSeconds() * 1000 : allDay ? DAY : 0));
  }
  if (end < start.date) end = new Date(start.date.getTime() + (allDay ? DAY : 0));
  if (allDay) end = new Date(Math.max(Math.ceil(end.getTime() / DAY) * DAY, start.date.getTime() + DAY));

  const toInstant = (value, prop) =>
    allDay ? dayFloor(value) : convertTime(value, prop.getParameter('tzid'), start.tzid).date;

  const recur = ve.getFirstPropertyValue('rrule');
  const exdates = [];
  for (const prop of ve.getAllProperties('exdate')) {
    for (const value of prop.getValues()) exdates.push(toInstant(value, prop));
  }
  const ridProp = ve.getFirstProperty('recurrence-id');

  const row = {
    uid: str(ve.getFirstPropertyValue('uid')),
    recurrence_id: ridProp ? toInstant(ridProp.getFirstValue(), ridProp) : null,
    title: str(ve.getFirstPropertyValue('summary'), 500) || '',
    description: str(ve.getFirstPropertyValue('description'), 10000),
    location: str(ve.getFirstPropertyValue('location'), 500),
    start_at: start.date,
    end_at: end,
    all_day: allDay,
    tzid: start.tzid,
    rrule: ridProp || !recur ? null : recur.toString(),
    exdates,
    cancelled: String(ve.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED',
  };
  row.range_end = computeRangeEnd(row);
  return row;
}

/** Index rows for one iCalendar resource. Cancelled occurrences become exclusions on the series. */
export function rowsFromVcalendar(vcal, defaultZone) {
  const rows = vcal
    .getAllSubcomponents('vevent')
    .map((ve) => rowFromComponent(ve, defaultZone))
    .filter(Boolean);
  const master = rows.find((r) => !r.recurrence_id);
  if (master?.cancelled) return [];
  const result = [];
  for (const row of rows) {
    if (row.cancelled && row.recurrence_id) {
      if (master) master.exdates.push(row.recurrence_id);
      continue;
    }
    if (!row.cancelled) result.push(row);
  }
  return result;
}

function newVcalendar() {
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  vcal.updatePropertyWithValue('prodid', '-//Hearth Calendar//EN');
  vcal.updatePropertyWithValue('version', '2.0');
  return vcal;
}

/** Splits a subscribed feed into one resource per UID so each can be indexed independently. */
export function splitFeed(text) {
  const vcal = parseIcs(text);
  const zones = new Map(vcal.getAllSubcomponents('vtimezone').map((z) => [z.getFirstPropertyValue('tzid'), z]));
  const groups = new Map();
  for (const ve of vcal.getAllSubcomponents('vevent')) {
    let uid = ve.getFirstPropertyValue('uid');
    if (!uid) {
      uid = crypto
        .createHash('sha1')
        .update(`${ve.getFirstPropertyValue('dtstart')}|${ve.getFirstPropertyValue('summary')}`)
        .digest('hex');
      ve.updatePropertyWithValue('uid', uid);
    }
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(ve);
  }
  const out = [];
  for (const [uid, components] of groups) {
    const resource = newVcalendar();
    const tzids = new Set();
    for (const ve of components) {
      for (const prop of ve.getAllProperties()) {
        const tz = prop.getParameter('tzid');
        if (tz) tzids.add(tz);
      }
    }
    for (const tz of tzids) {
      // Clone: addSubcomponent re-parents, and a zone can be shared by many resources.
      if (zones.has(tz)) resource.addSubcomponent(new ICAL.Component(structuredClone(zones.get(tz).jCal)));
    }
    for (const ve of components) resource.addSubcomponent(ve);
    out.push({ uid: String(uid), ics: resource.toString(), vcal: resource });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function makeTimeProperty(name, date, allDay, tzid) {
  const prop = new ICAL.Property(name);
  if (allDay) {
    prop.setValue(
      ICAL.Time.fromData({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        isDate: true,
      }),
    );
  } else if (!tzid || tzid === 'UTC' || !isZone(tzid)) {
    prop.setValue(ICAL.Time.fromJSDate(date, true));
  } else {
    const local = DateTime.fromJSDate(date, { zone: tzid });
    prop.setValue(
      ICAL.Time.fromData({
        year: local.year,
        month: local.month,
        day: local.day,
        hour: local.hour,
        minute: local.minute,
        second: local.second,
        isDate: false,
      }),
    );
    prop.setParameter('tzid', tzid);
  }
  return prop;
}

export function setTime(comp, name, date, allDay, tzid) {
  comp.removeAllProperties(name);
  comp.addProperty(makeTimeProperty(name, date, allDay, tzid));
}

function setText(comp, name, value) {
  comp.removeAllProperties(name);
  if (value !== null && value !== undefined && String(value) !== '') comp.addPropertyWithValue(name, String(value));
}

/** How the series' DTSTART is written, so EXDATE/RECURRENCE-ID values can match it. */
function startFormat(master, defaultZone) {
  const info = convertProp(master.getFirstProperty('dtstart'), defaultZone);
  return { allDay: info.allDay, tzid: info.tzid };
}

export function findMaster(vcal) {
  return vcal.getAllSubcomponents('vevent').find((ve) => !ve.hasProperty('recurrence-id')) || null;
}

export function findOverride(vcal, instant, defaultZone) {
  const master = findMaster(vcal);
  const allDay = master ? startFormat(master, defaultZone).allDay : false;
  return (
    vcal.getAllSubcomponents('vevent').find((ve) => {
      const prop = ve.getFirstProperty('recurrence-id');
      if (!prop) return false;
      const value = prop.getFirstValue();
      const date = allDay ? dayFloor(value) : convertTime(value, prop.getParameter('tzid'), defaultZone).date;
      return date.getTime() === instant.getTime();
    }) || null
  );
}

function touch(comp) {
  const now = ICAL.Time.fromJSDate(new Date(), true);
  comp.updatePropertyWithValue('dtstamp', now);
  comp.updatePropertyWithValue('last-modified', now);
  const seq = Number(comp.getFirstPropertyValue('sequence') || 0);
  comp.updatePropertyWithValue('sequence', seq + 1);
}

/**
 * Applies editable fields to a VEVENT. `fields` holds already-validated values:
 * { title, description, location, allDay, start: Date, end: Date, tzid, rrule (string|null|undefined) }
 */
export function applyFields(comp, fields) {
  if (fields.title !== undefined) setText(comp, 'summary', fields.title);
  if (fields.description !== undefined) setText(comp, 'description', fields.description);
  if (fields.location !== undefined) setText(comp, 'location', fields.location);
  if (fields.start) {
    comp.removeAllProperties('duration');
    setTime(comp, 'dtstart', fields.start, fields.allDay, fields.tzid);
    setTime(comp, 'dtend', fields.end, fields.allDay, fields.tzid);
  }
  if (fields.rrule !== undefined) {
    comp.removeAllProperties('rrule');
    if (fields.rrule) comp.addPropertyWithValue('rrule', ICAL.Recur.fromString(fields.rrule));
  }
  touch(comp);
}

export function createResource(uid, fields) {
  const vcal = newVcalendar();
  const ve = new ICAL.Component('vevent');
  ve.addPropertyWithValue('uid', uid);
  ve.addPropertyWithValue('created', ICAL.Time.fromJSDate(new Date(), true));
  applyFields(ve, fields);
  vcal.addSubcomponent(ve);
  return vcal;
}

/** New override VEVENT for one occurrence of a series, pre-filled from the series. */
export function addOverride(vcal, occurrence, defaultZone) {
  const master = findMaster(vcal);
  const fmt = startFormat(master, defaultZone);
  const masterRow = rowFromComponent(master, defaultZone);
  const duration = masterRow.end_at - masterRow.start_at;
  const ve = new ICAL.Component('vevent');
  ve.addPropertyWithValue('uid', master.getFirstPropertyValue('uid'));
  for (const name of ['summary', 'description', 'location', 'class', 'transp']) {
    const value = master.getFirstPropertyValue(name);
    if (value !== null && value !== undefined) ve.addPropertyWithValue(name, value);
  }
  ve.addProperty(makeTimeProperty('recurrence-id', occurrence, fmt.allDay, fmt.tzid));
  setTime(ve, 'dtstart', occurrence, fmt.allDay, fmt.tzid);
  setTime(ve, 'dtend', new Date(occurrence.getTime() + duration), fmt.allDay, fmt.tzid);
  vcal.addSubcomponent(ve);
  return ve;
}

export function addExdate(vcal, occurrence, defaultZone) {
  const master = findMaster(vcal);
  const fmt = startFormat(master, defaultZone);
  master.addProperty(makeTimeProperty('exdate', occurrence, fmt.allDay, fmt.tzid));
  touch(master);
}

export function removeOverridesAndExdates(vcal) {
  for (const ve of [...vcal.getAllSubcomponents('vevent')]) {
    if (ve.hasProperty('recurrence-id')) vcal.removeSubcomponent(ve);
  }
  findMaster(vcal)?.removeAllProperties('exdate');
}

/** Adds VTIMEZONE definitions for every IANA zone referenced, as CalDAV servers expect. */
export function ensureTimezones(vcal) {
  const present = new Set(vcal.getAllSubcomponents('vtimezone').map((z) => z.getFirstPropertyValue('tzid')));
  const needed = new Set();
  for (const ve of vcal.getAllSubcomponents('vevent')) {
    for (const prop of ve.getAllProperties()) {
      const tz = prop.getParameter('tzid');
      if (tz && !present.has(tz) && isZone(tz) && tz !== 'UTC') needed.add(tz);
    }
  }
  if (needed.size === 0) return vcal;
  const others = [...vcal.getAllSubcomponents()];
  vcal.removeAllSubcomponents();
  for (const tz of needed) {
    try {
      const block = tzlib_get_ical_block(tz);
      const text = Array.isArray(block) ? block[0] : block;
      if (text) vcal.addSubcomponent(new ICAL.Component(ICAL.parse(text)));
    } catch {
      /* zone not in library: servers generally still accept the TZID */
    }
  }
  for (const comp of others) vcal.addSubcomponent(comp);
  return vcal;
}

export { ICAL };
