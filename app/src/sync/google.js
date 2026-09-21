import { config } from '../config.js';
import { one, query } from '../db.js';
import { decrypt, encrypt, httpError } from '../lib/security.js';

export const GOOGLE_CALDAV_ROOT = 'https://apidata.googleusercontent.com/caldav/v2/';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar'];

export function authorizationUrl(state) {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...body }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `Google sign-in failed: ${json.error_description || json.error || res.status}`);
  return json;
}

export async function exchangeCode(code) {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: config.google.redirectUri });
  if (!tokens.refresh_token) throw httpError(502, 'Google did not return a refresh token. Remove Hearth from your Google account permissions and try again.');
  // The ID token came straight from Google over TLS, so its payload can be read without re-verifying.
  const payload = JSON.parse(Buffer.from(String(tokens.id_token).split('.')[1] || '', 'base64url').toString() || '{}');
  return {
    email: payload.email || 'Google account',
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: new Date(Date.now() + (tokens.expires_in - 60) * 1000),
  };
}

export async function accessToken(account) {
  if (account.access_token_enc && account.access_token_expires && new Date(account.access_token_expires) > new Date()) {
    return decrypt(account.access_token_enc);
  }
  const tokens = await tokenRequest({ refresh_token: decrypt(account.secret_enc), grant_type: 'refresh_token' });
  const expires = new Date(Date.now() + (tokens.expires_in - 60) * 1000);
  await query('UPDATE accounts SET access_token_enc = $1, access_token_expires = $2 WHERE id = $3', [
    encrypt(tokens.access_token),
    expires,
    account.id,
  ]);
  account.access_token_enc = encrypt(tokens.access_token);
  account.access_token_expires = expires;
  return tokens.access_token;
}

export async function listGoogleCalendars(account) {
  const token = await accessToken(account);
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw httpError(502, `Google Calendar API error: ${json.error?.message || res.status}. Is the Google Calendar API enabled for your project?`);
  }
  return (json.items || []).map((c) => ({
    url: `${GOOGLE_CALDAV_ROOT}${encodeURIComponent(c.id)}/events/`,
    name: c.summaryOverride || c.summary,
    color: c.backgroundColor || null,
    readOnly: !['owner', 'writer'].includes(c.accessRole),
  }));
}

export async function saveGoogleAccount(userId, result) {
  const existing = await one(`SELECT id FROM accounts WHERE user_id = $1 AND provider = 'google' AND label = $2`, [
    userId,
    result.email,
  ]);
  if (existing) {
    await query(
      'UPDATE accounts SET secret_enc = $1, access_token_enc = $2, access_token_expires = $3 WHERE id = $4',
      [encrypt(result.refreshToken), encrypt(result.accessToken), result.expiresAt, existing.id],
    );
    return existing.id;
  }
  const row = await one(
    `INSERT INTO accounts (user_id, provider, label, secret_enc, access_token_enc, access_token_expires)
     VALUES ($1, 'google', $2, $3, $4, $5) RETURNING id`,
    [userId, result.email, encrypt(result.refreshToken), encrypt(result.accessToken), result.expiresAt],
  );
  return row.id;
}
