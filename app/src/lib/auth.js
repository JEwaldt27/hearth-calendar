import { config } from '../config.js';
import { one, query } from '../db.js';
import { httpError, randomToken, sha256 } from './security.js';

const COOKIE = 'hearth_sid';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function createSession(res, userId) {
  const token = randomToken();
  const maxAge = config.sessionDays * 86400;
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [sha256(token), userId, maxAge],
  );
  res.append(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`,
  );
}

export async function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.cookieSecure ? '; Secure' : ''}`);
}

/** Resolves the caller from a session cookie or a wall-display token. */
export async function authenticate(req, _res, next) {
  try {
    const authz = req.headers.authorization || '';
    if (authz.startsWith('Display ')) {
      const row = await one(
        `UPDATE displays SET last_seen_at = now() WHERE token_hash = $1
         RETURNING id, name, settings, user_id`,
        [sha256(authz.slice(8).trim())],
      );
      if (row) {
        req.user = await one('SELECT id, email, name, is_admin FROM users WHERE id = $1', [row.user_id]);
        req.display = { id: row.id, name: row.name, settings: row.settings };
      }
    } else {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) {
        req.user = await one(
          `SELECT u.id, u.email, u.name, u.is_admin, u.digest_enabled, u.remind_minutes, u.remind_all_day, u.remind_chores_hour
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.expires_at > now()`,
          [sha256(token)],
        );
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Browsers cannot send custom headers cross-site without CORS, so this blocks CSRF on state-changing calls. */
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/google/callback')) return next();
  if (req.headers['x-requested-with'] !== 'fetch') return next(httpError(403, 'Missing request header.'));
  next();
}

/** Signed-in account holder (not a wall display). */
export function requireUser(req, _res, next) {
  if (!req.user) return next(httpError(401, 'Please sign in.'));
  if (req.display) return next(httpError(403, 'Displays cannot change account settings.'));
  next();
}

/** Signed-in account holder or an authorised wall display. */
export function requireAuth(req, _res, next) {
  if (!req.user) return next(httpError(401, 'Please sign in.'));
  next();
}

export function requireAdmin(req, _res, next) {
  if (!req.user || req.display) return next(httpError(401, 'Please sign in.'));
  if (!req.user.is_admin) return next(httpError(403, 'Only administrators can do that.'));
  next();
}

const attempts = new Map();

/** Small in-memory limiter: at most `max` requests per 15 minutes per IP, counted separately per bucket. */
export function rateLimit(bucket, max = 10) {
  return (req, _res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const entry = attempts.get(key) || { count: 0, reset: now + 15 * 60 * 1000 };
    if (now > entry.reset) Object.assign(entry, { count: 0, reset: now + 15 * 60 * 1000 });
    entry.count += 1;
    attempts.set(key, entry);
    if (entry.count > max) return next(httpError(429, 'Too many attempts. Try again in a few minutes.'));
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) if (now > entry.reset) attempts.delete(key);
  query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
}, 60 * 60 * 1000).unref();
