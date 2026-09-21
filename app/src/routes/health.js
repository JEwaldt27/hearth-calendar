import { Router } from 'express';
import { many, one } from '../db.js';
import { requireAdmin } from '../lib/auth.js';
import { alertSettings, notifyAdmins, saveAlertSettings } from '../lib/alerts.js';
import { appVersion, backupStatus, diskStatus, recentProblems, startedAt } from '../lib/health.js';
import { mailEnabled } from '../lib/mail.js';
import { httpError } from '../lib/security.js';

const router = Router();

router.get('/admin/health', requireAdmin, async (_req, res) => {
  const [backups, disk, db, counts, calendars, alerts] = await Promise.all([
    backupStatus(),
    diskStatus(),
    one('SELECT pg_database_size(current_database())::bigint AS bytes'),
    one(`SELECT (SELECT count(*) FROM users)::int AS users,
                (SELECT count(*) FROM calendars)::int AS calendars,
                (SELECT count(*) FROM calendar_objects)::int AS events,
                (SELECT count(*) FROM push_subscriptions)::int AS devices,
                (SELECT count(*) FROM displays)::int AS displays,
                (SELECT max(last_seen_at) FROM displays) AS display_seen`),
    many(
      `SELECT c.id, c.name, c.source, c.last_synced_at, c.sync_error, c.sync_failing_since, u.name AS owner
         FROM calendars c JOIN users u ON u.id = c.owner_id
        WHERE c.source <> 'local' ORDER BY c.sync_error IS NULL, c.name`,
    ),
    alertSettings(),
  ]);
  res.json({
    version: appVersion,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    database: { bytes: Number(db.bytes) },
    disk,
    backups,
    counts: { ...counts, displaySeen: counts.display_seen },
    mailEnabled: mailEnabled(),
    alerts,
    calendars: calendars.map((c) => ({
      id: c.id,
      name: c.name,
      source: c.source,
      owner: c.owner,
      lastSyncedAt: c.last_synced_at,
      error: c.sync_error,
      failingSince: c.sync_failing_since,
    })),
    problems: recentProblems(),
  });
});

router.put('/admin/alerts', requireAdmin, async (req, res) => {
  const value = { ...(await alertSettings()), enabled: Boolean(req.body.enabled) };
  await saveAlertSettings(value);
  res.json({ alerts: value });
});

router.post('/admin/alerts/test', requireAdmin, async (_req, res) => {
  const sent = await notifyAdmins(`test:${Date.now()}`, 'Test alert', 'This is a test of Hearth’s problem alerts. If you can read this, alerts reach you.', { force: true });
  if (!sent) throw httpError(400, 'No admins to alert.');
  res.json({ ok: true, mail: mailEnabled() });
});

export default router;
