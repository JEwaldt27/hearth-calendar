import { DateTime } from 'luxon';
import rrulePkg from 'rrule';

const { RRule } = rrulePkg;
const DAY = 86400000;

/**
 * rrule.js has no reliable DST handling, so recurrences are expanded in "floating" time:
 * wall-clock fields are stored as if they were UTC, expanded, then mapped back into the event's zone.
 * That keeps a 9:00 weekly meeting at 9:00 across daylight-saving changes.
 */
export function floating(date, zone) {
  if (zone === 'UTC') return date;
  const d = DateTime.fromJSDate(date, { zone });
  return new Date(Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second));
}

export function unfloat(date, zone) {
  if (zone === 'UTC') return date;
  return DateTime.fromObject(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
    },
    { zone },
  ).toJSDate();
}

export function buildRule(ev) {
  const zone = ev.all_day ? 'UTC' : ev.tzid || 'UTC';
  const opts = RRule.parseString(String(ev.rrule).replace(/^RRULE:/i, ''));
  opts.dtstart = floating(new Date(ev.start_at), zone);
  if (opts.until) opts.until = ev.all_day ? opts.until : floating(opts.until, zone);
  delete opts.tzid;
  return { rule: new RRule(opts), zone };
}

/** Start instants of every occurrence of `ev` that overlaps [from, to). */
export function occurrenceStarts(ev, from, to, limit = 1500) {
  const start = new Date(ev.start_at);
  const duration = new Date(ev.end_at) - start;
  const overlaps = (s) => s < to && (duration > 0 ? s.getTime() + duration > from : s >= from);
  if (!ev.rrule) return overlaps(start) ? [start] : [];

  let built;
  try {
    built = buildRule(ev);
  } catch {
    return overlaps(start) ? [start] : [];
  }
  const { rule, zone } = built;
  const windowStart = floating(new Date(from.getTime() - duration), zone);
  const windowEnd = floating(to, zone);
  const out = [];
  const excluded = new Set((ev.exdates || []).map((d) => new Date(d).getTime()));
  rule.between(new Date(windowStart - DAY), new Date(windowEnd.getTime() + DAY), true, (d, i) => {
    if (i >= limit) return false;
    const s = unfloat(d, zone);
    if (overlaps(s) && !excluded.has(s.getTime())) out.push(s);
    return true;
  });
  return out;
}

/** Last instant any occurrence can cover, or null for an endless series. Used to prune queries. */
export function computeRangeEnd(ev) {
  const start = new Date(ev.start_at);
  const end = new Date(ev.end_at);
  if (!ev.rrule) return end;
  try {
    const { rule, zone } = buildRule(ev);
    if (!rule.options.count && !rule.options.until) return null;
    const cap = 10000;
    const all = rule.all((_d, i) => i < cap);
    if (all.length >= cap) return null;
    if (all.length === 0) return end;
    return new Date(unfloat(all[all.length - 1], zone).getTime() + (end - start));
  } catch {
    return end;
  }
}
