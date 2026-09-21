import { Router } from 'express';
import { config } from '../config.js';
import { one, query, transaction } from '../db.js';
import { assertUuid, cleanText } from '../lib/access.js';
import { createSession, destroySession, rateLimit, requireAdmin, requireUser } from '../lib/auth.js';
import { buildDigest } from '../lib/digest.js';
import {
  clearMailSettings,
  layout,
  mailEnabled,
  mailSettings,
  normalizeMailInput,
  saveMailSettings,
  sendMail,
} from '../lib/mail.js';
import { emailPasswordLink, findPasswordToken, issuePasswordLink, PENDING_PASSWORD } from '../lib/passwords.js';
import { hashPassword, httpError, sha256, verifyPassword } from '../lib/security.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PALETTE = ['#e8594f', '#f29f3d', '#e5c134', '#5bb974', '#3fa7d6', '#6c7ee1', '#b76fd8', '#e56fa5'];

function userDto(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: u.is_admin,
    digestEnabled: Boolean(u.digest_enabled),
    remindMinutes: u.remind_minutes ?? 15,
    remindAllDay: u.remind_all_day ?? true,
    remindChoresHour: u.remind_chores_hour ?? null,
  };
}

const REMIND_MINUTES = [0, 5, 10, 15, 30, 60, 120];

function validPassword(value) {
  const password = String(value || '');
  if (password.length < 8) throw httpError(400, 'Passwords need at least 8 characters.');
  if (password.length > 200) throw httpError(400, 'That password is too long.');
  return password;
}

function validateAccount(body, { requirePassword = true } = {}) {
  const email = cleanText(body.email, 254).toLowerCase();
  const name = cleanText(body.name, 80);
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Please enter a valid email address.');
  if (!name) throw httpError(400, 'Please enter a name.');
  return { email, name, password: requirePassword ? validPassword(body.password) : null };
}

/** Creates a user plus a starter family member, calendar and chore list. A null password means "invited". */
export async function createUser({ email, name, password, isAdmin }) {
  const hash = password ? await hashPassword(password) : PENDING_PASSWORD;
  try {
    return await transaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO users (email, name, password_hash, is_admin) VALUES ($1,$2,$3,$4) RETURNING *',
        [email, name, hash, isAdmin],
      );
      const user = rows[0];
      const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      const member = await client.query('INSERT INTO members (owner_id, name, color) VALUES ($1,$2,$3) RETURNING id', [user.id, name, color]);
      await client.query(`INSERT INTO calendars (owner_id, name, color, member_id, source) VALUES ($1,$2,$3,$4,'local')`, [
        user.id, `${name}'s calendar`, color, member.rows[0].id,
      ]);
      await client.query('INSERT INTO lists (owner_id, name, color) VALUES ($1,$2,$3)', [user.id, 'Chores', '#5bb974']);
      await client.query(`INSERT INTO lists (owner_id, name, color, kind) VALUES ($1,'Groceries','#f29f3d','checklist')`, [user.id]);
      return user;
    });
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'An account with that email already exists.');
    throw err;
  }
}

router.get('/auth/status', async (req, res) => {
  const { n } = await one('SELECT count(*)::int AS n FROM users');
  res.json({
    needsSetup: n === 0,
    signupAllowed: n === 0 || config.allowSignup,
    googleEnabled: config.google.enabled,
    mailEnabled: mailEnabled(),
    user: req.user && !req.display ? userDto(req.user) : null,
  });
});

router.post('/auth/register', rateLimit('register', 10), async (req, res) => {
  const data = validateAccount(req.body);
  const { n } = await one('SELECT count(*)::int AS n FROM users');
  if (n > 0 && !config.allowSignup) throw httpError(403, 'Sign-up is closed. Ask an administrator to create your account.');
  const user = await createUser({ ...data, isAdmin: n === 0 });
  await createSession(res, user.id);
  res.status(201).json({ user: userDto(user) });
});

router.post('/auth/login', rateLimit('login', 20), async (req, res) => {
  const email = cleanText(req.body.email, 254).toLowerCase();
  const user = await one('SELECT * FROM users WHERE lower(email) = $1', [email]);
  // Always run a hash so response time does not reveal whether the email exists.
  const ok = await verifyPassword(String(req.body.password || ''), user?.password_hash || 'scrypt$AAAA$AAAA');
  if (!user || !ok) throw httpError(401, 'Incorrect email or password.');
  await createSession(res, user.id);
  res.json({ user: userDto(user) });
});

router.post('/auth/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

// --- Forgot / reset password and invites -------------------------------------

router.post('/auth/forgot', rateLimit('forgot', 5), async (req, res) => {
  if (!mailEnabled()) throw httpError(400, 'Email isn’t set up on this server. Ask your administrator to reset your password.');
  const email = cleanText(req.body.email, 254).toLowerCase();
  const user = await one('SELECT id, name, email, password_hash FROM users WHERE lower(email) = $1', [email]);
  if (user) {
    const purpose = user.password_hash === PENDING_PASSWORD ? 'invite' : 'reset';
    const link = await issuePasswordLink(user.id, purpose);
    // Never reveal whether the address has an account, even if sending fails.
    await emailPasswordLink(user, link, purpose).catch(() => {});
  }
  res.json({ ok: true });
});

router.post('/auth/token', rateLimit('token', 30), async (req, res) => {
  const row = await findPasswordToken(req.body.token);
  if (!row) throw httpError(400, 'This link has expired or was already used. Ask for a new one.');
  res.json({ name: row.name, email: row.email, purpose: row.purpose });
});

router.post('/auth/reset', rateLimit('reset', 20), async (req, res) => {
  const hash = await hashPassword(validPassword(req.body.password));
  const userId = await transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE password_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256(String(req.body.token || ''))],
    );
    if (!rows.length) throw httpError(400, 'This link has expired or was already used. Ask for a new one.');
    const id = rows[0].user_id;
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await client.query('DELETE FROM password_tokens WHERE user_id = $1 AND used_at IS NULL', [id]);
    return id;
  });
  await createSession(res, userId);
  res.json({ user: userDto(await one('SELECT * FROM users WHERE id = $1', [userId])) });
});

// --- Profile ----------------------------------------------------------------

router.get('/me', requireUser, async (req, res) => {
  res.json({ user: userDto(await one('SELECT * FROM users WHERE id = $1', [req.user.id])) });
});

router.patch('/me', requireUser, async (req, res) => {
  const current = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const name = req.body.name !== undefined ? cleanText(req.body.name, 80) : current.name;
  if (!name) throw httpError(400, 'Please enter your name.');
  const digest = req.body.digestEnabled !== undefined ? Boolean(req.body.digestEnabled) : current.digest_enabled;
  let remindMinutes = current.remind_minutes;
  if (req.body.remindMinutes !== undefined) {
    remindMinutes = Number(req.body.remindMinutes);
    if (!REMIND_MINUTES.includes(remindMinutes)) throw httpError(400, 'Invalid reminder time.');
  }
  const remindAllDay = req.body.remindAllDay !== undefined ? Boolean(req.body.remindAllDay) : current.remind_all_day;
  let choresHour = current.remind_chores_hour;
  if (req.body.remindChoresHour !== undefined) {
    choresHour = req.body.remindChoresHour === null || req.body.remindChoresHour === '' ? null : Number(req.body.remindChoresHour);
    if (choresHour !== null && !(Number.isInteger(choresHour) && choresHour >= 0 && choresHour <= 23)) throw httpError(400, 'Invalid chores reminder hour.');
  }
  const user = await one(
    `UPDATE users SET name = $1, digest_enabled = $2, remind_minutes = $3, remind_all_day = $4, remind_chores_hour = $5
      WHERE id = $6 RETURNING *`,
    [name, digest, remindMinutes, remindAllDay, choresHour, req.user.id],
  );
  res.json({ user: userDto(user) });
});

router.post('/me/digest/test', requireUser, rateLimit('digest-test', 5), async (req, res) => {
  const user = await one('SELECT id, name, email FROM users WHERE id = $1', [req.user.id]);
  const digest = await buildDigest(user, undefined, { always: true });
  await sendMail({ to: user.email, ...digest });
  res.json({ ok: true });
});

router.post('/me/password', requireUser, rateLimit('change-password', 10), async (req, res) => {
  const row = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(String(req.body.current || ''), row.password_hash))) throw httpError(400, 'Your current password is incorrect.');
  const next = validPassword(req.body.next);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(next), req.user.id]);
  await query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
  await createSession(res, req.user.id);
  res.json({ ok: true });
});

// --- Administration -------------------------------------------------------

router.get('/admin/users', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    'SELECT id, email, name, is_admin, created_at, password_hash = $1 AS pending FROM users ORDER BY created_at',
    [PENDING_PASSWORD],
  );
  res.json({ users: rows.map((u) => ({ ...userDto(u), createdAt: u.created_at, pending: u.pending })), mailEnabled: mailEnabled() });
});

/** Emails the link when possible; always returns it so the admin can share it another way. */
async function deliverLink(user, purpose, adminName) {
  const link = await issuePasswordLink(user.id, purpose);
  let emailed = false;
  let emailError = null;
  try {
    emailed = await emailPasswordLink(user, link, purpose, adminName);
  } catch (err) {
    emailError = err.message;
  }
  return { link, emailed, emailError };
}

router.post('/admin/users', requireAdmin, async (req, res) => {
  const invite = Boolean(req.body.invite);
  const data = validateAccount(req.body, { requirePassword: !invite });
  const user = await createUser({ ...data, isAdmin: Boolean(req.body.isAdmin) });
  const delivery = invite ? await deliverLink(user, 'invite', req.user.name) : {};
  res.status(201).json({ user: userDto(user), ...delivery });
});

router.post('/admin/users/:id/reset-link', requireAdmin, async (req, res) => {
  const user = await one('SELECT id, name, email, password_hash FROM users WHERE id = $1', [assertUuid(req.params.id, 'user')]);
  if (!user) throw httpError(404, 'User not found.');
  res.json(await deliverLink(user, user.password_hash === PENDING_PASSWORD ? 'invite' : 'reset', req.user.name));
});

router.post('/admin/users/:id/password', requireAdmin, async (req, res) => {
  const id = assertUuid(req.params.id, 'user');
  if (id === req.user.id) throw httpError(400, 'Change your own password under Settings → Profile.');
  const hash = await hashPassword(validPassword(req.body.password));
  const { rowCount } = await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
  if (!rowCount) throw httpError(404, 'User not found.');
  await query('DELETE FROM sessions WHERE user_id = $1', [id]);
  await query('DELETE FROM password_tokens WHERE user_id = $1 AND used_at IS NULL', [id]);
  res.json({ ok: true });
});

router.patch('/admin/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) throw httpError(400, 'You cannot change your own admin status.');
  const user = await one('UPDATE users SET is_admin = $1 WHERE id = $2 RETURNING *', [Boolean(req.body.isAdmin), assertUuid(req.params.id, 'user')]);
  if (!user) throw httpError(404, 'User not found.');
  res.json({ user: userDto(user) });
});

router.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) throw httpError(400, 'You cannot delete your own account here.');
  const { rowCount } = await query('DELETE FROM users WHERE id = $1', [assertUuid(req.params.id, 'user')]);
  if (!rowCount) throw httpError(404, 'User not found.');
  res.json({ ok: true });
});


// --- Email settings (admin) ------------------------------------------------------

function mailDto() {
  const s = mailSettings();
  return {
    enabled: mailEnabled(),
    source: s.source,
    host: s.host || '',
    port: s.port || 587,
    secure: Boolean(s.secure),
    user: s.user || '',
    from: s.from || '',
    hasPassword: Boolean(s.pass),
    digestHour: s.digestHour ?? 7,
    timezone: config.defaultTimezone,
  };
}

router.get('/admin/mail', requireAdmin, (_req, res) => {
  res.json({ mail: mailDto() });
});

router.put('/admin/mail', requireAdmin, async (req, res) => {
  await saveMailSettings(normalizeMailInput(req.body));
  res.json({ mail: mailDto() });
});

/** Sends a test message with the settings in the form (not yet saved) to the admin's own address. */
router.post('/admin/mail/test', requireAdmin, rateLimit('mail-test', 10), async (req, res) => {
  const settings = normalizeMailInput(req.body);
  await sendMail(
    {
      to: req.user.email,
      subject: 'Hearth Calendar test email',
      text: `It works! Hearth can send email from ${settings.from}.\n`,
      html: layout('It works! 🎉', `<p>Hearth can send email from <strong>${settings.from.replace(/[<>&"]/g, '')}</strong>.</p><p>Password reset links, invites and morning summaries will use these settings once you save them.</p>`),
    },
    settings,
  );
  res.json({ ok: true, to: req.user.email });
});

router.delete('/admin/mail', requireAdmin, async (_req, res) => {
  await clearMailSettings();
  res.json({ mail: mailDto() });
});

export default router;
