import { config } from '../config.js';
import { one, query } from '../db.js';
import { button, escapeHtml, layout, mailEnabled, sendMail } from './mail.js';
import { randomToken, sha256 } from './security.js';

/** Stored instead of a hash for invited users who have not chosen a password yet. */
export const PENDING_PASSWORD = 'invite-pending';

const LIFETIME_HOURS = { reset: 2, invite: 24 * 7 };

/** Creates a single-use link, replacing any earlier unused link for the same user. */
export async function issuePasswordLink(userId, purpose) {
  await query('DELETE FROM password_tokens WHERE user_id = $1 AND used_at IS NULL', [userId]);
  const token = randomToken(32);
  await query(
    `INSERT INTO password_tokens (token_hash, user_id, purpose, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [sha256(token), userId, purpose, LIFETIME_HOURS[purpose]],
  );
  // The token sits in the URL fragment so it never reaches server or proxy logs.
  return `${config.baseUrl}/reset#token=${token}`;
}

/** Valid, unused token joined with its user, or null. */
export function findPasswordToken(token) {
  return one(
    `SELECT t.token_hash, t.purpose, u.id AS user_id, u.name, u.email
       FROM password_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
    [sha256(String(token || ''))],
  );
}

/** Emails a reset or invite link. Returns true if sent, false if email is not configured. */
export async function emailPasswordLink(user, link, purpose, invitedBy) {
  if (!mailEnabled()) return false;
  if (purpose === 'invite') {
    await sendMail({
      to: user.email,
      subject: `${invitedBy || 'Your family'} invited you to Hearth Calendar`,
      text: `Hi ${user.name},\n\n${invitedBy || 'Someone'} set up an account for you on your family's Hearth Calendar.\nChoose your password here (the link works for 7 days):\n\n${link}\n`,
      html: layout(
        'You’re invited to Hearth',
        `<p>Hi ${escapeHtml(user.name)},</p><p>${escapeHtml(invitedBy || 'Someone')} set up an account for you on your family's calendar. Choose a password to get started. This link works for 7 days.</p>${button(link, 'Choose my password')}`,
      ),
    });
  } else {
    await sendMail({
      to: user.email,
      subject: 'Reset your Hearth Calendar password',
      text: `Hi ${user.name},\n\nUse this link to choose a new password (it works for 2 hours):\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.\n`,
      html: layout(
        'Reset your password',
        `<p>Hi ${escapeHtml(user.name)},</p><p>Use the button below to choose a new password. The link works for 2 hours.</p>${button(link, 'Choose a new password')}<p style="color:#8f857b">If you didn't ask for this, you can ignore this email.</p>`,
      ),
    });
  }
  return true;
}
