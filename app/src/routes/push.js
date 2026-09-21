import { Router } from 'express';
import { rateLimit, requireUser } from '../lib/auth.js';
import { countSubscriptions, removeSubscription, saveSubscription, sendToUser, vapidPublicKey } from '../lib/push.js';
import { httpError } from '../lib/security.js';

const router = Router();

router.get('/push/key', requireUser, async (req, res) => {
  res.json({ publicKey: vapidPublicKey(), devices: await countSubscriptions(req.user.id) });
});

router.post('/push/subscribe', requireUser, async (req, res) => {
  await saveSubscription(req.user.id, req.body.subscription, req.headers['user-agent']);
  res.json({ ok: true, devices: await countSubscriptions(req.user.id) });
});

router.post('/push/unsubscribe', requireUser, async (req, res) => {
  await removeSubscription(req.user.id, req.body.endpoint);
  res.json({ ok: true, devices: await countSubscriptions(req.user.id) });
});

router.post('/push/test', requireUser, rateLimit('push-test', 10), async (req, res) => {
  const delivered = await sendToUser(req.user.id, {
    title: 'Hearth reminders are on 🎉',
    body: 'This is what an event reminder will look like.',
    url: '/#settings/profile',
    tag: 'hearth-test',
  });
  if (!delivered) throw httpError(400, 'No devices have reminders turned on yet.');
  res.json({ ok: true, delivered });
});

export default router;
