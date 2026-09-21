import { createResource } from '../calendar/ical.js';
import { upsertObject } from '../calendar/store.js';
import { one, transaction } from '../db.js';

/**
 * Birthdays live on an automatic "Birthdays" calendar per account (managed = 'birthdays'),
 * one yearly all-day event per family member. It can be shared, shown on displays, subscribed
 * to and reminded about like any other calendar, but is edited through Family members.
 */
async function birthdayCalendar(ownerId, create) {
  const existing = await one("SELECT * FROM calendars WHERE owner_id = $1 AND managed = 'birthdays'", [ownerId]);
  if (existing || !create) return existing;
  return one(
    `INSERT INTO calendars (owner_id, name, color, source, managed) VALUES ($1, 'Birthdays', '#e56fa5', 'local', 'birthdays') RETURNING *`,
    [ownerId],
  );
}

const uidFor = (member) => `birthday-${member.id}@hearth`;

export async function syncMemberBirthday(member) {
  const calendar = await birthdayCalendar(member.owner_id, Boolean(member.birthday));
  if (!calendar) return;
  const uid = uidFor(member);
  const existing = await one('SELECT id FROM calendar_objects WHERE calendar_id = $1 AND uid = $2', [calendar.id, uid]);
  if (!member.birthday) {
    if (existing) await transaction((c) => c.query('DELETE FROM calendar_objects WHERE id = $1', [existing.id]));
    return;
  }
  const [y, m, d] = String(member.birthday).slice(0, 10).split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const vcal = createResource(uid, {
    title: `🎂 ${member.name}’s birthday`,
    description: member.birthday_year_known ? `Born ${y}` : '',
    location: '',
    allDay: true,
    tzid: 'UTC',
    start,
    end: new Date(start.getTime() + 86400000),
    // February 29th birthdays are celebrated on the last day of February in other years.
    rrule: m === 2 && d === 29 ? 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1' : 'FREQ=YEARLY',
  });
  await transaction((c) => upsertObject(c, calendar.id, { id: existing?.id, uid, href: null, etag: null, ics: vcal.toString(), vcal }));
}

export async function removeMemberBirthday(member) {
  await syncMemberBirthday({ ...member, birthday: null });
}
