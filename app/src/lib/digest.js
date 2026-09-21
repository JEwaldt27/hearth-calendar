import { DateTime } from 'luxon';
import { listOccurrences } from '../calendar/store.js';
import { config } from '../config.js';
import { many, query } from '../db.js';
import { accessibleCalendars, accessibleLists } from './access.js';
import { button, escapeHtml, layout, mailEnabled, mailSettings, sendMail } from './mail.js';

function sortEvents(list) {
  return list.sort((a, b) => (a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

function eventsOn(events, dayStart) {
  const dayStr = dayStart.toISODate();
  const start = dayStart.toJSDate();
  const end = dayStart.plus({ days: 1 }).toJSDate();
  return sortEvents(
    events.filter((ev) => {
      if (ev.allDay) return ev.start <= dayStr && ev.end > dayStr;
      const s = new Date(ev.start);
      const e = new Date(ev.end);
      return s < end && (e > start || (+e === +s && s >= start));
    }),
  );
}

/** Chores from chore-chart lists that are still open on `day` (a luxon DateTime). */
export async function choresFor(userId, day) {
  const lists = (await accessibleLists(userId)).filter((l) => l.kind === 'chores');
  if (!lists.length) return [];
  const today = day.toISODate();
  const weekdayBit = 1 << (day.weekday % 7); // luxon: Mon=1..Sun=7 -> JS: Sun=0..Sat=6
  const rows = await many(
    `SELECT i.title, i.repeat_days, i.due_date, i.completed_at, m.name AS member_name, m.emoji,
            c.day IS NOT NULL AS done_today
       FROM list_items i
       LEFT JOIN members m ON m.id = i.member_id
       LEFT JOIN list_item_completions c ON c.item_id = i.id AND c.day = $2
      WHERE i.list_id = ANY($1)
      ORDER BY i.sort, i.created_at`,
    [lists.map((l) => l.id), today],
  );
  return rows.filter((i) =>
    i.repeat_days
      ? i.repeat_days & weekdayBit && (!i.due_date || i.due_date <= today) && !i.done_today
      : !i.completed_at && (!i.due_date || i.due_date <= today),
  );
}

function timeLabel(ev) {
  if (ev.allDay) return 'All day';
  return DateTime.fromISO(ev.start).setZone(config.defaultTimezone).toLocaleString(DateTime.TIME_SIMPLE);
}

function eventRowsHtml(list, calendars) {
  if (!list.length) return '<p style="color:#8f857b;margin:0 0 8px">Nothing planned.</p>';
  return `<table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:8px">${list
    .map((ev) => {
      const cal = calendars.get(ev.calendarId);
      const color = cal?.pref_color || cal?.color || '#8d7b6a';
      return `<tr>
        <td style="width:10px;padding:7px 8px 7px 0;vertical-align:top"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${escapeHtml(color)}"></span></td>
        <td style="width:84px;padding:4px 8px 4px 0;color:#5d544c;vertical-align:top;white-space:nowrap">${escapeHtml(timeLabel(ev))}</td>
        <td style="padding:4px 0;vertical-align:top"><strong>${escapeHtml(ev.title || '(untitled)')}</strong>${ev.location ? `<br><span style="color:#8f857b;font-size:13px">${escapeHtml(ev.location)}</span>` : ''}</td>
      </tr>`;
    })
    .join('')}</table>`;
}

function eventLinesText(list) {
  if (!list.length) return '  Nothing planned.\n';
  return list.map((ev) => `  ${timeLabel(ev).padEnd(9)} ${ev.title}${ev.location ? ` (${ev.location})` : ''}\n`).join('');
}

/**
 * Builds the morning summary for one user. Returns null when there is nothing to report,
 * unless `always` is set (used by "send me a test").
 */
export async function buildDigest(user, now = DateTime.now().setZone(config.defaultTimezone), { always = false } = {}) {
  const day = now.startOf('day');
  const tomorrow = day.plus({ days: 1 });
  const calendars = (await accessibleCalendars(user.id)).filter((c) => c.visible);
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const events = await listOccurrences(calendars.map((c) => c.id), day.toJSDate(), tomorrow.plus({ days: 1 }).toJSDate());
  const today = eventsOn(events, day);
  const next = eventsOn(events, tomorrow);
  const chores = await choresFor(user.id, day);
  if (!always && !today.length && !next.length && !chores.length) return null;

  const groups = new Map();
  for (const c of chores) {
    const who = c.member_name ? `${c.emoji ? `${c.emoji} ` : ''}${c.member_name}` : 'Anyone';
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(c.title);
  }
  const dayName = day.toFormat('cccc, LLLL d');
  const subject = today.length
    ? `Today: ${today.length} event${today.length === 1 ? '' : 's'}${chores.length ? ` · ${chores.length} chore${chores.length === 1 ? '' : 's'}` : ''}`
    : chores.length
      ? `Today: ${chores.length} chore${chores.length === 1 ? '' : 's'}`
      : 'Your day at a glance';

  const choresHtml = chores.length
    ? `<h2 style="font-size:16px;margin:18px 0 8px">Chores for today</h2>${[...groups]
        .map(([who, titles]) => `<p style="margin:0 0 8px"><strong>${escapeHtml(who)}</strong><br>${titles.map((t) => `☐ ${escapeHtml(t)}`).join('<br>')}</p>`)
        .join('')}`
    : '';
  const html = layout(
    `Good morning, ${user.name}`,
    `<h2 style="font-size:16px;margin:0 0 8px">Today · ${escapeHtml(dayName)}</h2>${eventRowsHtml(today, byId)}
     <h2 style="font-size:16px;margin:18px 0 8px">Tomorrow</h2>${eventRowsHtml(next, byId)}
     ${choresHtml}${button(config.baseUrl, 'Open Hearth')}
     <p style="color:#8f857b;font-size:12px">Turn these emails off in Settings → Profile.</p>`,
  );
  const text =
    `Good morning, ${user.name}\n\nToday (${dayName}):\n${eventLinesText(today)}\nTomorrow:\n${eventLinesText(next)}` +
    (chores.length ? `\nChores for today:\n${[...groups].map(([who, titles]) => `  ${who}: ${titles.join(', ')}\n`).join('')}` : '') +
    `\n${config.baseUrl}\n`;
  return { subject, html, text };
}

async function sendDueDigests() {
  if (!mailEnabled()) return;
  const now = DateTime.now().setZone(config.defaultTimezone);
  // Only in a short window after the configured hour, so a restart in the evening doesn't send a "morning" email.
  const hour = mailSettings().digestHour;
  if (now.hour < hour || now.hour >= hour + 3) return;
  const today = now.toISODate();
  const users = await many(
    'SELECT id, name, email FROM users WHERE digest_enabled AND (last_digest_on IS NULL OR last_digest_on < $1)',
    [today],
  );
  for (const user of users) {
    // Mark first so a failing mail server can't cause repeated sends.
    await query('UPDATE users SET last_digest_on = $1 WHERE id = $2', [today, user.id]);
    try {
      const digest = await buildDigest(user, now);
      if (digest) await sendMail({ to: user.email, ...digest });
    } catch (err) {
      console.warn(`Morning summary for ${user.email} failed: ${err.message}`);
    }
  }
}

export function startDigestScheduler() {
  const tick = () => sendDueDigests().catch((err) => console.warn('Digest scheduler error:', err.message));
  setTimeout(tick, 15000);
  setInterval(tick, 5 * 60 * 1000).unref();
}
