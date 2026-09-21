import { Router } from 'express';
import { many, one, query, transaction } from '../db.js';
import { assertUuid, cleanText, visibleMembers } from '../lib/access.js';
import { requireAuth, requireUser } from '../lib/auth.js';
import { httpError } from '../lib/security.js';

const router = Router();

async function visibleMemberIds(userId) {
  return (await visibleMembers(userId)).map((m) => m.id);
}

/** Star balances for every family member the caller can see. */
router.get('/stars', requireAuth, async (req, res) => {
  const ids = await visibleMemberIds(req.user.id);
  const rows = ids.length
    ? await many('SELECT member_id, COALESCE(SUM(delta), 0)::int AS balance FROM star_ledger WHERE member_id = ANY($1) GROUP BY member_id', [ids])
    : [];
  res.json({ balances: Object.fromEntries(rows.map((r) => [r.member_id, r.balance])) });
});

router.get('/stars/:memberId/history', requireUser, async (req, res) => {
  const memberId = assertUuid(req.params.memberId, 'member');
  if (!(await visibleMemberIds(req.user.id)).includes(memberId)) throw httpError(404, 'Family member not found.');
  const rows = await many(
    `SELECT l.delta, l.reason, l.day, l.created_at, u.name AS by_name
       FROM star_ledger l LEFT JOIN users u ON u.id = l.created_by
      WHERE l.member_id = $1 ORDER BY l.created_at DESC LIMIT 60`,
    [memberId],
  );
  res.json({ history: rows.map((r) => ({ delta: r.delta, reason: r.reason, day: r.day, at: r.created_at, by: r.by_name })) });
});

async function ownMember(userId, memberId) {
  const m = await one('SELECT * FROM members WHERE id = $1 AND owner_id = $2', [assertUuid(memberId, 'member'), userId]);
  if (!m) throw httpError(403, 'Only the person who added this family member can change their stars.');
  return m;
}

/** Bonus or deduction by a parent: { memberId, delta, reason }. */
router.post('/stars/adjust', requireUser, async (req, res) => {
  const member = await ownMember(req.user.id, req.body.memberId);
  const delta = Number(req.body.delta);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000) throw httpError(400, 'Enter a number of stars.');
  await query('INSERT INTO star_ledger (member_id, delta, reason, created_by) VALUES ($1,$2,$3,$4)', [
    member.id, delta, cleanText(req.body.reason, 120) || (delta > 0 ? 'Bonus' : 'Adjustment'), req.user.id,
  ]);
  res.json({ ok: true });
});

// --- Rewards ------------------------------------------------------------------------------

function rewardDto(r, userId) {
  return { id: r.id, title: r.title, emoji: r.emoji, cost: r.cost, ownerId: r.owner_id, mine: r.owner_id === userId };
}

router.get('/rewards', requireAuth, async (req, res) => {
  const owners = [...new Set((await visibleMembers(req.user.id)).map((m) => m.owner_id).concat(req.user.id))];
  const rows = await many('SELECT * FROM rewards WHERE owner_id = ANY($1) ORDER BY cost, title', [owners]);
  res.json({ rewards: rows.map((r) => rewardDto(r, req.user.id)) });
});

function cleanReward(body) {
  const title = cleanText(body.title, 100);
  const cost = Number(body.cost);
  if (!title) throw httpError(400, 'Name the reward.');
  if (!Number.isInteger(cost) || cost < 1 || cost > 10000) throw httpError(400, 'The cost must be a whole number of stars.');
  return { title, cost, emoji: cleanText(body.emoji, 8) || null };
}

router.post('/rewards', requireUser, async (req, res) => {
  const r = cleanReward(req.body);
  const row = await one('INSERT INTO rewards (owner_id, title, emoji, cost) VALUES ($1,$2,$3,$4) RETURNING *', [req.user.id, r.title, r.emoji, r.cost]);
  res.status(201).json({ reward: rewardDto(row, req.user.id) });
});

router.patch('/rewards/:id', requireUser, async (req, res) => {
  const r = cleanReward(req.body);
  const row = await one('UPDATE rewards SET title = $1, emoji = $2, cost = $3 WHERE id = $4 AND owner_id = $5 RETURNING *', [
    r.title, r.emoji, r.cost, assertUuid(req.params.id, 'reward'), req.user.id,
  ]);
  if (!row) throw httpError(404, 'Reward not found.');
  res.json({ reward: rewardDto(row, req.user.id) });
});

router.delete('/rewards/:id', requireUser, async (req, res) => {
  const { rowCount } = await query('DELETE FROM rewards WHERE id = $1 AND owner_id = $2', [assertUuid(req.params.id, 'reward'), req.user.id]);
  if (!rowCount) throw httpError(404, 'Reward not found.');
  res.json({ ok: true });
});

/** Spends stars on a reward. Only the parent who added the family member can do this. */
router.post('/rewards/:id/redeem', requireUser, async (req, res) => {
  const reward = await one('SELECT * FROM rewards WHERE id = $1', [assertUuid(req.params.id, 'reward')]);
  if (!reward) throw httpError(404, 'Reward not found.');
  const member = await ownMember(req.user.id, req.body.memberId);
  const balance = await transaction(async (client) => {
    // Serialise redemptions per member so two taps can't overspend.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [member.id]);
    const { rows } = await client.query('SELECT COALESCE(SUM(delta), 0)::int AS balance FROM star_ledger WHERE member_id = $1', [member.id]);
    if (rows[0].balance < reward.cost) throw httpError(400, `${member.name} needs ${reward.cost - rows[0].balance} more ⭐ for this.`);
    await client.query('INSERT INTO star_ledger (member_id, delta, reason, created_by) VALUES ($1,$2,$3,$4)', [
      member.id, -reward.cost, `${reward.emoji ? `${reward.emoji} ` : ''}${reward.title}`, req.user.id,
    ]);
    return rows[0].balance - reward.cost;
  });
  res.json({ ok: true, balance });
});

export default router;
