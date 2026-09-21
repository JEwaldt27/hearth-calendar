import { Router } from 'express';
import { one, query } from '../db.js';
import { assertUuid, cleanColor, cleanText, visibleMembers } from '../lib/access.js';
import { requireAuth, requireUser } from '../lib/auth.js';
import { httpError } from '../lib/security.js';

const router = Router();

function memberDto(m) {
  return { id: m.id, name: m.name, color: m.color, emoji: m.emoji, mine: m.mine, ownerId: m.owner_id };
}

router.get('/members', requireAuth, async (req, res) => {
  res.json({ members: (await visibleMembers(req.user.id)).map(memberDto) });
});

router.post('/members', requireUser, async (req, res) => {
  const name = cleanText(req.body.name, 60);
  if (!name) throw httpError(400, 'Please enter a name.');
  const row = await one(
    `INSERT INTO members (owner_id, name, color, emoji, sort)
     VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(sort), 0) + 1 FROM members WHERE owner_id = $1)) RETURNING *, true AS mine`,
    [req.user.id, name, cleanColor(req.body.color, '#6c7ee1'), cleanText(req.body.emoji, 8) || null],
  );
  res.status(201).json({ member: memberDto(row) });
});

router.patch('/members/:id', requireUser, async (req, res) => {
  const current = await one('SELECT * FROM members WHERE id = $1 AND owner_id = $2', [assertUuid(req.params.id, 'member'), req.user.id]);
  if (!current) throw httpError(404, 'Family member not found.');
  const row = await one('UPDATE members SET name = $1, color = $2, emoji = $3 WHERE id = $4 RETURNING *, true AS mine', [
    req.body.name !== undefined ? cleanText(req.body.name, 60) || current.name : current.name,
    req.body.color !== undefined ? cleanColor(req.body.color, current.color) : current.color,
    req.body.emoji !== undefined ? cleanText(req.body.emoji, 8) || null : current.emoji,
    current.id,
  ]);
  res.json({ member: memberDto(row) });
});

router.delete('/members/:id', requireUser, async (req, res) => {
  const { rowCount } = await query('DELETE FROM members WHERE id = $1 AND owner_id = $2', [assertUuid(req.params.id, 'member'), req.user.id]);
  if (!rowCount) throw httpError(404, 'Family member not found.');
  res.json({ ok: true });
});

export default router;
