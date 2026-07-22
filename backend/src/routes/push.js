// ═══════════════════════════════════════════════════════════════════════
// Routes push — architecture hybride : push_subscriptions reste sur
// Supabase (RLS "push_own", cf. migration 20260624000001), donc l'abonnement
// / désabonnement se fait DIRECTEMENT depuis le client via
// js/supabase-client.js (sb.from('push_subscriptions')...), pas ici.
//
// Ce backend n'a besoin d'un accès à push_subscriptions que pour l'ENVOI
// (la clé privée VAPID doit rester côté serveur) — cf. lib/push.js, qui lit
// les abonnements via lib/supabaseDb.js.
// ═══════════════════════════════════════════════════════════════════════
const express = require('express');
const { requireAuth } = require('../lib/auth');
const { sendPushToUser } = require('../lib/push');

const router = express.Router();

// ── POST /push/test ── (bouton "📤 Tester" — l'utilisateur ne peut se pusher qu'à lui-même)
router.post('/test', requireAuth, async (req, res, next) => {
  try {
    const result = await sendPushToUser(req.user.id, {
      title: '🔔 Test Livraisanté',
      body: 'Les notifications push fonctionnent correctement sur cet appareil.',
      url: '/',
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
