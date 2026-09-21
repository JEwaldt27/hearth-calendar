import { config } from '../config.js';
import { many, one, query } from '../db.js';
import { accessibleCalendars } from '../lib/access.js';
import { ICAL, parseIcs } from './ical.js';

export function feedUrl(token) {
  return `${config.baseUrl}/ics/${token}.ics`;
}

/**
 * Builds a read-only iCalendar feed for a subscribe link, or returns null if the link is
 * unknown or its owner has lost access to the calendar. Access is re-checked on every fetch.
 */
export async function buildFeed(token) {
  const row = await one('SELECT f.*, u.name AS user_name FROM feed_tokens f JOIN users u ON u.id = f.user_id WHERE f.token = $1', [token]);
  if (!row) return null;
  const calendars = (await accessibleCalendars(row.user_id)).filter((c) => (row.calendar_id ? c.id === row.calendar_id : c.visible));
  if (row.calendar_id && !calendars.length) return null;

  const out = new ICAL.Component(['vcalendar', [], []]);
  out.updatePropertyWithValue('prodid', '-//Hearth Calendar//EN');
  out.updatePropertyWithValue('version', '2.0');
  out.updatePropertyWithValue('calscale', 'GREGORIAN');
  out.updatePropertyWithValue('x-wr-calname', row.calendar_id ? calendars[0].name : `${row.user_name} · Hearth`);
  out.updatePropertyWithValue('x-wr-timezone', config.defaultTimezone);
  out.updatePropertyWithValue('x-published-ttl', 'PT15M');
  // ical.js adds VALUE=DURATION itself when the value is a duration.
  const refresh = new ICAL.Property('refresh-interval');
  refresh.setValue(ICAL.Duration.fromString('PT15M'));
  out.addProperty(refresh);

  const objects = calendars.length
    ? await many('SELECT ics FROM calendar_objects WHERE calendar_id = ANY($1)', [calendars.map((c) => c.id)])
    : [];
  const zones = new Set();
  const events = [];
  for (const { ics } of objects) {
    let vcal;
    try {
      vcal = parseIcs(ics);
    } catch {
      continue;
    }
    for (const vtz of vcal.getAllSubcomponents('vtimezone')) {
      const tzid = vtz.getFirstPropertyValue('tzid');
      if (tzid && !zones.has(tzid)) {
        zones.add(tzid);
        out.addSubcomponent(new ICAL.Component(structuredClone(vtz.jCal)));
      }
    }
    for (const ve of vcal.getAllSubcomponents('vevent')) events.push(new ICAL.Component(structuredClone(ve.jCal)));
  }
  for (const ve of events) out.addSubcomponent(ve);

  query('UPDATE feed_tokens SET last_used_at = now() WHERE token = $1', [token]).catch(() => {});
  return out.toString();
}
