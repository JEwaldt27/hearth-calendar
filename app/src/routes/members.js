import { Router } from 'express';
import { one, query } from '../db.js';
import { assertUuid, cleanColor, cleanText, visibleMembers } from '../lib/access.js';
import { requireAuth, requireUser } from '../lib/auth.js';
import { removeMemberBirthday, syncMemberBirthday } from '../lib/birthdays.js';
import { httpError } from '../lib/security.js';

const router = Router();

function memberDto(m) {
  return {
    id: m.id,
    name: m.name,
    color: m.color,
    emoji: m.emoji,
    mine: m.mine,
    ownerId: m.owner_id,
    birthday: m.birthday ? String(m.birthday).slice(0, 10) : null,
    birthdayYearKnown: m.birthday_year_known ?? true,
  };
}

/** 'YYYY-MM-DD' or null. With an unknown year, the date is stored in 2000 (a leap year, so Feb 29 works). */
function cleanBirthday(body, current) {
  if (body.birthday === undefined) return { birthday: current?.birthday ?? null, known: current?.birthday_year_known ?? true };
  if (!body.birthday) return { birthday: null, known: true };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(body.birthday));
  const known = body.birthdayYearKnown !== false;
  // Round-trip through Date.UTC to reject impossible days such as Feb 30 (any leap year works when the year is unknown).
  const check = m && new Date(Date.UTC(known ? Number(m[1]) : 2000, Number(m[2]) - 1, Number(m[3])));
  if (!m || check.getUTCMonth() !== Number(m[2]) - 1 || check.getUTCDate() !== Number(m[3])) throw httpError(400, 'Birthday must be a real date.');
  return { birthday: known ? body.birthday : `2000-${m[2]}-${m[3]}`, known };
}

router.get('/members', requireAuth, async (req, res) => {
  res.json({ members: (await visibleMembers(req.user.id)).map(memberDto) });
});

router.post('/members', requireUser, async (req, res) => {
  const name = cleanText(req.body.name, 60);
  if (!name) throw httpError(400, 'Please enter a name.');
  const bday = cleanBirthday(req.body);
  const row = await one(
    `INSERT INTO members (owner_id, name, color, emoji, birthday, birthday_year_known, sort)
     VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(max(sort), 0) + 1 FROM members WHERE owner_id = $1)) RETURNING *, true AS mine`,
    [req.user.id, name, cleanColor(req.body.color, '#6c7ee1'), cleanText(req.body.emoji, 8) || null, bday.birthday, bday.known],
  );
  await syncMemberBirthday(row);
  res.status(201).json({ member: memberDto(row) });
});

router.patch('/members/:id', requireUser, async (req, res) => {
  const current = await one('SELECT * FROM members WHERE id = $1 AND owner_id = $2', [assertUuid(req.params.id, 'member'), req.user.id]);
  if (!current) throw httpError(404, 'Family member not found.');
  const bday = cleanBirthday(req.body, current);
  const row = await one(
    'UPDATE members SET name = $1, color = $2, emoji = $3, birthday = $4, birthday_year_known = $5 WHERE id = $6 RETURNING *, true AS mine',
    [
      req.body.name !== undefined ? cleanText(req.body.name, 60) || current.name : current.name,
      req.body.color !== undefined ? cleanColor(req.body.color, current.color) : current.color,
      req.body.emoji !== undefined ? cleanText(req.body.emoji, 8) || null : current.emoji,
      bday.birthday,
      bday.known,
      current.id,
    ],
  );
  await syncMemberBirthday(row);
  res.json({ member: memberDto(row) });
});

router.delete('/members/:id', requireUser, async (req, res) => {
  const member = await one('SELECT * FROM members WHERE id = $1 AND owner_id = $2', [assertUuid(req.params.id, 'member'), req.user.id]);
  if (!member) throw httpError(404, 'Family member not found.');
  await removeMemberBirthday(member);
  await query('DELETE FROM members WHERE id = $1', [member.id]);
  res.json({ ok: true });
});

export default router;
