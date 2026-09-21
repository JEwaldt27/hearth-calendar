import { config } from '../config.js';
import { many, one, query } from '../db.js';
import { backupStatus, diskStatus, startedAt } from './health.js';
import { escapeHtml, layout, mailEnabled, sendMail } from './mail.js';
import { sendToUser } from './push.js';

export async function alertSettings() {
  const row = await one("SELECT value FROM app_settings WHERE key = 'alerts'");
  return { enabled: true, ...(row?.value || {}) };
}

export async function saveAlertSettings(value) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('alerts', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [value],
  );
}

/**
 * Emails and pushes every admin. `key` de-duplicates: the same key is sent at most once per admin
 * (include the date in the key for "at most once a day").
 */
export async function notifyAdmins(key, subject, text, { force = false } = {}) {
  if (!force && !(await alertSettings()).enabled) return 0;
  const admins = await many('SELECT id, name, email FROM users WHERE is_admin');
  let sent = 0;
  for (const admin of admins) {
    if (!force) {
      const { rowCount } = await query('INSERT INTO reminder_log (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [admin.id, `alert:${key}`]);
      if (rowCount !== 1) continue;
    }
    if (mailEnabled()) {
      await sendMail({
        to: admin.email,
        subject: `Hearth: ${subject}`,
        text: `${text}\n\nOpen Settings → Server health for details: ${config.baseUrl}/#settings/health\n`,
        html: layout(subject, `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p><p><a href="${escapeHtml(config.baseUrl)}/#settings/health">Open Server health</a></p>`),
      }).catch(() => {});
    }
    await sendToUser(admin.id, { title: `Hearth: ${subject}`, body: text.slice(0, 180), url: '/#settings/health', tag: `alert-${key}` }).catch(() => {});
    sent += 1;
  }
  return sent;
}

const today = () => new Date().toISOString().slice(0, 10);

async function runChecks() {
  // Linked calendars that have been failing for more than two hours.
  const failing = await many(
    `SELECT c.id, c.name, c.sync_error, u.name AS owner FROM calendars c JOIN users u ON u.id = c.owner_id
      WHERE c.sync_failing_since < now() - interval '2 hours'`,
  );
  for (const c of failing) {
    await notifyAdmins(`sync:${c.id}:${today()}`, `“${c.name}” isn’t syncing`, `${c.owner}'s calendar “${c.name}” has failed to sync for over two hours.\nLast error: ${c.sync_error}`);
  }

  // Backups: newest file older than 30 hours (only once the server has been up long enough to have made one).
  const backups = await backupStatus();
  if (backups.available && Date.now() - startedAt > 2 * 3600000) {
    const age = backups.latest ? Date.now() - new Date(backups.latest.at) : Infinity;
    if (age > 30 * 3600000) {
      await notifyAdmins(
        `backup:${today()}`,
        'Backups have stopped',
        backups.latest ? `The newest database backup is from ${new Date(backups.latest.at).toLocaleString()}.` : 'No database backups were found.',
      );
    }
  }

  // Disk nearly full.
  const disk = await diskStatus();
  if (disk && (disk.free / disk.total < 0.1 || disk.free < 2 * 1024 ** 3)) {
    await notifyAdmins(`disk:${today()}`, 'The server is running out of space', `Only ${(disk.free / 1024 ** 3).toFixed(1)} GB of ${(disk.total / 1024 ** 3).toFixed(0)} GB is free.`);
  }
}

/** Detects crashes/power loss: the flag is cleared on start and set again on a clean shutdown. */
async function checkLastShutdown() {
  const row = await one("SELECT value FROM app_settings WHERE key = 'lifecycle'");
  if (row && row.value.clean === false) {
    await notifyAdmins(
      `restart:${startedAt.toISOString()}`,
      'Hearth restarted unexpectedly',
      `Hearth started again at ${startedAt.toLocaleString()} without shutting down cleanly first (a crash, reboot or power cut). Everything should be working again; this is just so you know.`,
    );
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('lifecycle', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [{ clean: false, startedAt: startedAt.toISOString() }],
  );
}

export async function markCleanShutdown() {
  await query("UPDATE app_settings SET value = jsonb_set(value, '{clean}', 'true'), updated_at = now() WHERE key = 'lifecycle'").catch(() => {});
}

export function startAlerts() {
  const safe = (fn) => () => fn().catch((err) => console.warn('Alert check failed:', err.message));
  setTimeout(safe(checkLastShutdown), 30000);
  setTimeout(safe(runChecks), 60000);
  setInterval(safe(runChecks), 15 * 60000).unref();
}
