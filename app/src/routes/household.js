import express, { Router } from 'express';
import { many, one, query } from '../db.js';
import { assertUuid } from '../lib/access.js';
import { requireAdmin, requireAuth, requireUser } from '../lib/auth.js';
import { geocode, householdSettings, saveHouseholdSettings, weather } from '../lib/household.js';
import { httpError } from '../lib/security.js';

const router = Router();

// --- Household (location + units) and weather ------------------------------------------

router.get('/household', requireAuth, async (_req, res) => {
  const h = await householdSettings();
  res.json({ household: { placeName: h.placeName, units: h.units, configured: h.latitude !== null } });
});

router.put('/admin/household', requireAdmin, async (req, res) => {
  const h = await saveHouseholdSettings(req.body || {});
  res.json({ household: { placeName: h.placeName, units: h.units, configured: h.latitude !== null } });
});

router.get('/admin/geocode', requireAdmin, async (req, res) => {
  res.json({ results: await geocode(req.query.q) });
});

router.get('/weather', requireAuth, async (_req, res) => {
  res.json({ weather: await weather() });
});

// --- Photos for the display's photo frame ------------------------------------------------

const MAX_PHOTOS = 300;

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

router.get('/photos', requireAuth, async (req, res) => {
  const rows = await many('SELECT id, width, height, bytes, created_at FROM photos WHERE owner_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ photos: rows.map((p) => ({ id: p.id, width: p.width, height: p.height, bytes: p.bytes, createdAt: p.created_at })) });
});

router.get('/photos/:id', requireAuth, async (req, res) => {
  const row = await one('SELECT mime, data FROM photos WHERE id = $1 AND owner_id = $2', [assertUuid(req.params.id, 'photo'), req.user.id]);
  if (!row) throw httpError(404, 'Photo not found.');
  res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=604800, immutable' }).send(row.data);
});

router.post('/photos', requireUser, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '8mb' }), async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  const mime = buf && sniffImage(buf);
  if (!mime) throw httpError(400, 'Please upload a JPEG, PNG or WebP image.');
  const { n } = await one('SELECT count(*)::int AS n FROM photos WHERE owner_id = $1', [req.user.id]);
  if (n >= MAX_PHOTOS) throw httpError(400, `You can keep up to ${MAX_PHOTOS} photos. Delete some first.`);
  const width = Number.parseInt(req.headers['x-image-width'], 10) || null;
  const height = Number.parseInt(req.headers['x-image-height'], 10) || null;
  const row = await one(
    'INSERT INTO photos (owner_id, mime, width, height, bytes, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at',
    [req.user.id, mime, width, height, buf.length, buf],
  );
  res.status(201).json({ photo: { id: row.id, width, height, bytes: buf.length, createdAt: row.created_at } });
});

router.delete('/photos/:id', requireUser, async (req, res) => {
  const { rowCount } = await query('DELETE FROM photos WHERE id = $1 AND owner_id = $2', [assertUuid(req.params.id, 'photo'), req.user.id]);
  if (!rowCount) throw httpError(404, 'Photo not found.');
  res.json({ ok: true });
});

export default router;
