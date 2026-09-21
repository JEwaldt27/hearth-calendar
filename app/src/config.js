const env = process.env;

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const baseUrl = (env.BASE_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/+$/, '');

export const config = {
  port: int(env.PORT, 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://hearth:hearth@localhost:5432/hearth',
  appSecret: env.APP_SECRET || '',
  baseUrl,
  // First account can always be created; after that only when this is on (admins can still add users).
  allowSignup: bool(env.ALLOW_SIGNUP, false),
  cookieSecure: bool(env.COOKIE_SECURE, baseUrl.startsWith('https://')),
  trustProxy: bool(env.TRUST_PROXY, true),
  defaultTimezone: env.DEFAULT_TIMEZONE || 'America/Chicago',
  syncIntervalMinutes: Math.max(1, int(env.SYNC_INTERVAL_MINUTES, 15)),
  syncPastDays: int(env.SYNC_PAST_DAYS, 365),
  syncFutureDays: int(env.SYNC_FUTURE_DAYS, 3 * 365),
  // Linked calendar URLs may point at your LAN (e.g. a home Nextcloud) unless this is on.
  blockPrivateNetworks: bool(env.BLOCK_PRIVATE_NETWORKS, false),
  sessionDays: int(env.SESSION_DAYS, 30),
  mail: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    // true for port 465 (implicit TLS); port 587 upgrades with STARTTLS automatically.
    secure: bool(env.SMTP_SECURE, int(env.SMTP_PORT, 587) === 465),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || env.SMTP_USER || '',
    get enabled() {
      return Boolean(this.host && this.from);
    },
  },
  // Local hour (in DEFAULT_TIMEZONE) when morning summaries go out.
  digestHour: Math.min(23, Math.max(0, int(env.DIGEST_HOUR, 7))),
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
    redirectUri: `${baseUrl}/api/google/callback`,
  },
};

if (!config.appSecret || config.appSecret.length < 32) {
  console.error('APP_SECRET must be set to a random string of at least 32 characters (try: openssl rand -hex 32)');
  process.exit(1);
}
