import { many, one, query } from '../db.js';
import { assertUuid, cleanText } from '../lib/access.js';
import { httpError } from '../lib/security.js';

/**
 * Share endpoints for a resource type ('calendar' or 'list'). `access(userId, id, needed)` must
 * throw unless the caller has the needed permission.
 */
export function mountShares(router, { path, table, column, access, requireUser }) {
  router.get(`/${path}/:id/shares`, requireUser, async (req, res) => {
    await access(req.user.id, assertUuid(req.params.id), 'owner');
    res.json({ shares: await sharesFor(table, column, [req.params.id]) });
  });

  router.post(`/${path}/:id/shares`, requireUser, async (req, res) => {
    await access(req.user.id, assertUuid(req.params.id), 'owner');
    const email = cleanText(req.body.email, 254).toLowerCase();
    const permission = req.body.permission === 'edit' ? 'edit' : 'view';
    const target = await one('SELECT id FROM users WHERE lower(email) = $1', [email]);
    if (!target) throw httpError(404, 'No account uses that email. They need to sign up (or be added by an admin) first.');
    if (target.id === req.user.id) throw httpError(400, 'You already own this.');
    await query(
      `INSERT INTO ${table} (${column}, user_id, permission) VALUES ($1, $2, $3)
       ON CONFLICT (${column}, user_id) DO UPDATE SET permission = EXCLUDED.permission`,
      [req.params.id, target.id, permission],
    );
    res.status(201).json({ shares: await sharesFor(table, column, [req.params.id]) });
  });

  router.delete(`/${path}/:id/shares/:userId`, requireUser, async (req, res) => {
    await access(req.user.id, assertUuid(req.params.id), 'owner');
    await query(`DELETE FROM ${table} WHERE ${column} = $1 AND user_id = $2`, [req.params.id, assertUuid(req.params.userId, 'user')]);
    res.json({ shares: await sharesFor(table, column, [req.params.id]) });
  });
}

export async function sharesFor(table, column, ids) {
  if (ids.length === 0) return [];
  const rows = await many(
    `SELECT s.${column} AS resource_id, s.permission, u.id AS user_id, u.name, u.email
       FROM ${table} s JOIN users u ON u.id = s.user_id
      WHERE s.${column} = ANY($1) ORDER BY u.name`,
    [ids],
  );
  return rows.map((r) => ({ resourceId: r.resource_id, userId: r.user_id, name: r.name, email: r.email, permission: r.permission }));
}
