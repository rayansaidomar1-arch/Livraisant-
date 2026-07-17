// Routes push — remplace sbSubscribePush + test côté client de la fonction send-push
const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../lib/auth');
const { sendPushToUser } = require('../lib/push');

const router = express.Router();

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

// ── POST /push/subscribe ── (équivalent sbSubscribePush)
router.post('/subscribe', requireAuth, async (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { endpoint, keys } = parsed.data;

  await prisma.pushSubscription.upsert({
    where: { userId_endpoint: { userId: req.user.id, endpoint } },
    update: { p256dh: keys.p256dh, auth: keys.auth },
    create: { userId: req.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
  });
  res.status(201).json({ ok: true });
});

// ── DELETE /push/subscribe ── (désabonnement, ex. déconnexion)
router.delete('/subscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint requis' });
  await prisma.pushSubscription.deleteMany({ where: { userId: req.user.id, endpoint } });
  res.json({ ok: true });
});

// ── POST /push/test ── (bouton "📤 Tester" — l'utilisateur ne peut se pusher qu'à lui-même)
router.post('/test', requireAuth, async (req, res) => {
  const result = await sendPushToUser(req.user.id, {
    title: '🔔 Test Livraisanté',
    body: 'Les notifications push fonctionnent correctement sur cet appareil.',
    url: '/',
  });
  res.json(result);
});

// ── POST /push/send ── (serveur→serveur uniquement, ex. déclenché par une autre route interne)
// Non exposé publiquement ici : utiliser directement sendPushToUser() depuis les autres routes.

module.exports = router;
