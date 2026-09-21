import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { recordProblem } from './health.js';
import { decrypt, encrypt, httpError } from './security.js';

/**
 * Outgoing email settings. Saved in the admin panel (app_settings 'mail'); when nothing has been
 * saved there, the SMTP_* variables from .env are used instead.
 */
let current = null;
let transport = null;

function fromEnv() {
  return {
    source: 'env',
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    user: config.mail.user,
    pass: config.mail.pass,
    from: config.mail.from,
    digestHour: config.digestHour,
  };
}

export async function loadMailSettings() {
  const row = await one("SELECT value FROM app_settings WHERE key = 'mail'");
  if (row) {
    const v = row.value;
    let pass = '';
    try {
      pass = v.passEnc ? decrypt(v.passEnc) : '';
    } catch {
      console.warn('Saved email password could not be decrypted (was APP_SECRET changed?). Re-enter it in Settings → Email.');
    }
    current = { source: 'admin', host: v.host, port: v.port, secure: v.secure, user: v.user, pass, from: v.from, digestHour: v.digestHour ?? 7 };
  } else {
    current = fromEnv();
  }
  transport = null;
  return current;
}

export function mailSettings() {
  return current || fromEnv();
}

/** Validates admin input; a blank password keeps the saved one. */
export function normalizeMailInput(body, existing = mailSettings()) {
  const host = String(body.host || '').trim();
  const port = Number.parseInt(body.port, 10) || 587;
  const from = String(body.from || '').trim();
  const user = String(body.user || '').trim();
  const pass = body.password ? String(body.password) : existing.pass || '';
  const digestHour = Math.min(23, Math.max(0, Number.parseInt(body.digestHour, 10) || 0));
  if (!host) throw httpError(400, 'Enter the SMTP server (for example smtp.gmail.com).');
  if (port < 1 || port > 65535) throw httpError(400, 'That port number is not valid.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) throw httpError(400, 'Enter the email address messages should come from.');
  return { host, port, secure: body.secure === undefined ? port === 465 : Boolean(body.secure), user, pass, from, digestHour };
}

export async function saveMailSettings(settings) {
  const value = { ...settings, pass: undefined, passEnc: settings.pass ? encrypt(settings.pass) : null };
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('mail', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [value],
  );
  return loadMailSettings();
}

export async function clearMailSettings() {
  await query("DELETE FROM app_settings WHERE key = 'mail'");
  return loadMailSettings();
}

function createTransport(s) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
  });
}

export function mailEnabled() {
  const s = mailSettings();
  return Boolean(s.host && s.from);
}

/** Sends with the saved settings, or with `settings` when given (used to test before saving). */
export async function sendMail({ to, subject, text, html }, settings) {
  const s = settings || mailSettings();
  if (!settings && !mailEnabled()) throw httpError(400, 'Email is not set up yet. An admin can turn it on in Settings → Email.');
  try {
    const t = settings ? createTransport(s) : (transport ||= createTransport(s));
    await t.sendMail({ from: `Hearth Calendar <${s.from}>`, to, subject, text, html });
  } catch (err) {
    console.warn(`Email to ${to} failed: ${err.message}`);
    if (!settings) recordProblem('email', `To ${to}: ${friendlyMailError(err)}`);
    throw httpError(502, `The email could not be sent: ${friendlyMailError(err)}`);
  }
}

function friendlyMailError(err) {
  const msg = String(err.message || err);
  if (/Invalid login|535|Username and Password not accepted/i.test(msg)) {
    return 'the server rejected the username or password. For Gmail and iCloud, use an app password, not your normal password.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'the SMTP server name could not be found.';
  if (/ETIMEDOUT|ECONNREFUSED|Greeting never received/i.test(msg)) {
    return 'could not connect. Check the server and port (587 with encryption off, or 465 with it on).';
  }
  if (/wrong version number|ssl/i.test(msg)) return 'encryption setting mismatch. Use port 587 with "SSL/TLS" off, or 465 with it on.';
  return msg;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Wraps email body HTML in a simple, client-safe layout (inline styles only). */
export function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#faf6f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#2a241f">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="font-weight:800;font-size:18px;margin-bottom:16px"><span style="display:inline-block;background:#e0763b;color:#fff;border-radius:8px;width:26px;height:26px;text-align:center;line-height:26px;margin-right:6px">◐</span>Hearth</div>
  <div style="background:#fff;border:1px solid #ebe3d8;border-radius:14px;padding:22px">
    <h1 style="font-size:20px;margin:0 0 14px">${escapeHtml(title)}</h1>
    ${bodyHtml}
  </div>
  <p style="color:#8f857b;font-size:12px;margin-top:16px">Sent by your family's Hearth Calendar at ${escapeHtml(config.baseUrl)}</p>
</div></body></html>`;
}

export function button(href, label) {
  return `<p style="margin:20px 0"><a href="${escapeHtml(href)}" style="background:#e0763b;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px;display:inline-block">${escapeHtml(label)}</a></p>
<p style="color:#8f857b;font-size:12px;word-break:break-all">Or paste this link into your browser:<br>${escapeHtml(href)}</p>`;
}
