import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { migrate, pool, waitForDatabase } from './db.js';
import { authenticate, csrfGuard } from './lib/auth.js';
import authRoutes from './routes/auth.js';
import calendarRoutes from './routes/calendars.js';
import displayRoutes from './routes/displays.js';
import eventRoutes from './routes/events.js';
import householdRoutes from './routes/household.js';
import { feedApi, serveFeed } from './routes/feeds.js';
import listRoutes from './routes/lists.js';
import memberRoutes from './routes/members.js';
import pushRoutes from './routes/push.js';
import { startDigestScheduler } from './lib/digest.js';
import { initPush } from './lib/push.js';
import { startReminderScheduler } from './lib/reminders.js';
import { loadMailSettings } from './lib/mail.js';
import { startScheduler } from './sync/sync.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 'loopback, linklocal, uniquelocal');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'blob:'],
        'upgrade-insecure-requests': config.cookieSecure ? [] : null,
      },
    },
    strictTransportSecurity: config.cookieSecure,
    crossOriginOpenerPolicy: false,
  }),
);

app.get('/healthz', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

const api = express.Router();
api.use(express.json({ limit: '1mb' }));
api.use(authenticate);
api.use(csrfGuard);
api.use(authRoutes);
api.use(memberRoutes);
api.use(calendarRoutes);
api.use(eventRoutes);
api.use(listRoutes);
api.use(displayRoutes);
api.use(feedApi);
api.use(pushRoutes);
api.use(householdRoutes);
api.use((_req, _res, next) => {
  const err = new Error('Not found');
  err.status = 404;
  next(err);
});
app.use('/api', api);

// Calendar subscribe links for phones (the token in the URL is the credential).
app.get('/ics/:file', serveFeed);

// No build step or hashed filenames, so let browsers revalidate (cheap 304s) to pick up upgrades immediately.
app.use(express.static(publicDir, { extensions: ['html'], index: 'index.html', maxAge: 0 }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(`${req.method} ${req.originalUrl}`, err);
  res.status(status).json({ error: status >= 500 && !err.status ? 'Something went wrong on the server.' : err.message });
});

await waitForDatabase();
await migrate();
await loadMailSettings();
await initPush();
app.listen(config.port, () => {
  console.log(`Hearth Calendar listening on port ${config.port} (${config.baseUrl})`);
});
startScheduler();
startDigestScheduler();
startReminderScheduler();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
