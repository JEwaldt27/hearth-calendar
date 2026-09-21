import webpush from 'web-push';
import { config } from '../config.js';
import { many, one, query } from '../db.js';
import { recordProblem } from './health.js';
import { mailSettings } from './mail.js';
import { decrypt, encrypt } from './security.js';

let publicKey = null;

/** Loads (or creates on first run) the server's VAPID keys used to sign push messages. */
export async function initPush() {
  let row = await one("SELECT value FROM app_settings WHERE key = 'vapid'");
  if (!row) {
    const keys = webpush.generateVAPIDKeys();
    await query(`INSERT INTO app_settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [
      { publicKey: keys.publicKey, privateKeyEnc: encrypt(keys.privateKey) },
    ]);
    row = await one("SELECT value FROM app_settings WHERE key = 'vapid'");
  }
  publicKey = row.value.publicKey;
  webpush.setVapidDetails(contactSubject(), publicKey, decrypt(row.value.privateKeyEnc));
}

function contactSubject() {
  const from = mailSettings().from;
  if (from && from.includes('@')) return `mailto:${from}`;
  if (config.baseUrl.startsWith('https://')) return config.baseUrl;
  return 'mailto:admin@hearth.invalid';
}

export function vapidPublicKey() {
  return publicKey;
}

export async function saveSubscription(userId, sub, userAgent) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw Object.assign(new Error('Invalid push subscription.'), { status: 400 });
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
    [userId, endpoint, p256dh, auth, String(userAgent || '').slice(0, 300)],
  );
}

export async function removeSubscription(userId, endpoint) {
  await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, String(endpoint || '')]);
}

export function countSubscriptions(userId) {
  return one('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [userId]).then((r) => r.n);
}

/**
 * Sends a notification to every device the user turned on. `payload`: { title, body, url, tag }.
 * Dead subscriptions (uninstalled app, revoked permission) are removed. Returns devices reached.
 */
export async function sendToUser(userId, payload) {
  const subs = await many('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  let delivered = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), {
        TTL: 60 * 60,
        urgency: 'high',
        timeout: 15000,
      });
      delivered += 1;
      query('UPDATE push_subscriptions SET last_success_at = now() WHERE id = $1', [s.id]).catch(() => {});
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
      } else {
        console.warn(`Push to a device of user ${userId} failed: ${err.statusCode || ''} ${err.body || err.message}`);
        recordProblem('push', `${err.statusCode || ''} ${err.body || err.message}`.trim());
      }
    }
  }
  return delivered;
}
