import { DateTime } from 'luxon';
import { listOccurrences } from '../calendar/store.js';
import { config } from '../config.js';
import { many, query } from '../db.js';
import { accessibleCalendars } from './access.js';
import { choresFor } from './digest.js';
import { sendToUser } from './push.js';

/** Records a reminder as sent. Returns true only the first time, so each reminder goes out once. */
async function claim(userId, key) {
  const { rowCount } = await query('INSERT INTO reminder_log (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, key]);
  return rowCount === 1;
}

const time = (date) => DateTime.fromJSDate(date).setZone(config.defaultTimezone).toLocaleString(DateTime.TIME_SIMPLE);

async function remindUser(user, now, local) {
  const calendars = (await accessibleCalendars(user.id)).filter((c) => c.visible);
  const ids = calendars.map((c) => c.id);

  // Timed events: "Soccer practice at 5:00 PM (in 15 min)".
  if (user.remind_minutes > 0 && ids.length) {
    const lead = user.remind_minutes * 60000;
    const events = await listOccurrences(ids, now, new Date(now.getTime() + lead + 60000));
    for (const ev of events) {
      if (ev.allDay) continue;
      const start = new Date(ev.start);
      if (start <= now || start.getTime() - lead > now.getTime()) continue;
      if (!(await claim(user.id, `event:${ev.id}`))) continue;
      const minutes = Math.max(1, Math.round((start - now) / 60000));
      await sendToUser(user.id, {
        title: ev.title || 'Event',
        body: `${time(start)} · in ${minutes} min${ev.location ? ` · ${ev.location}` : ''}`,
        url: '/#calendar',
        tag: `event-${ev.id}`,
      });
    }
  }

  const today = local.toISODate();
  // All-day events, once in the morning.
  if (user.remind_all_day && local.hour >= 8 && local.hour < 11 && ids.length) {
    const dayStart = local.startOf('day');
    const events = (await listOccurrences(ids, dayStart.toJSDate(), dayStart.plus({ days: 1 }).toJSDate())).filter(
      (ev) => ev.allDay && ev.start <= today && ev.end > today,
    );
    if (events.length && (await claim(user.id, `allday:${today}`))) {
      await sendToUser(user.id, {
        title: events.length === 1 ? `Today: ${events[0].title}` : `Today: ${events.length} all-day events`,
        body: events.map((e) => e.title).join(' · '),
        url: '/#calendar',
        tag: `allday-${today}`,
      });
    }
  }

  // Chores still open at the chosen hour.
  const hour = user.remind_chores_hour;
  if (hour !== null && hour !== undefined && local.hour >= hour && local.hour < hour + 2) {
    const open = await choresFor(user.id, local.startOf('day'));
    if (open.length && (await claim(user.id, `chores:${today}`))) {
      const titles = open.slice(0, 4).map((c) => (c.member_name ? `${c.member_name}: ${c.title}` : c.title));
      await sendToUser(user.id, {
        title: `${open.length} chore${open.length === 1 ? '' : 's'} left today`,
        body: titles.join(' · ') + (open.length > 4 ? ' …' : ''),
        url: '/#chores',
        tag: `chores-${today}`,
      });
    }
  }
}

async function tick() {
  const users = await many(
    `SELECT u.id, u.remind_minutes, u.remind_all_day, u.remind_chores_hour
       FROM users u WHERE EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)`,
  );
  const now = new Date();
  const local = DateTime.fromJSDate(now).setZone(config.defaultTimezone);
  for (const user of users) {
    try {
      await remindUser(user, now, local);
    } catch (err) {
      console.warn(`Reminders for user ${user.id} failed: ${err.message}`);
    }
  }
}

export function startReminderScheduler() {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } catch (err) {
      console.warn('Reminder scheduler error:', err.message);
    } finally {
      busy = false;
    }
  };
  setTimeout(run, 20000);
  setInterval(run, 60000).unref();
  setInterval(() => query("DELETE FROM reminder_log WHERE sent_at < now() - interval '3 days'").catch(() => {}), 3600000).unref();
}
