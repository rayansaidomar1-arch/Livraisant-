require('dotenv').config();
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const ordersRoutes = require('./routes/orders');
const { router: paymentsRoutes, webhookRouter: stripeWebhookRouter } = require('./routes/payments');
const pushRoutes = require('./routes/push');
const realtime = require('./lib/realtime');
const prisma = require('./lib/prisma');
const { pool } = require('./lib/supabaseDb');

const app = express();
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || 'https://livraisante.fr',
  credentials: true,
}));

// ── IMPORTANT : la route Stripe webhook doit recevoir le corps BRUT (raw)
// pour que la vérification de signature fonctionne — elle est donc montée sur son
// PROPRE chemin exact /payments/webhook, AVANT express.json(), afin qu'aucun autre
// parser ne touche le body et que /payments/create-intent reste en JSON classique.
app.use('/payments/webhook', express.raw({ type: 'application/json' }), stripeWebhookRouter);

// Pour toutes les autres routes : JSON classique
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true, service: 'livraisante-backend', time: new Date().toISOString() }));

// ── Limitation de débit ──
// Montée APRÈS le webhook Stripe volontairement : celui-ci est un appel
// serveur→serveur qui rejoue ses événements en rafale après une panne, et le
// brider ferait perdre des validations de paiement. Sa légitimité repose sur la
// signature HMAC, pas sur un quota. /health est également hors quota : c'est la
// sonde de Clever Cloud, la brider ferait redémarrer l'instance en boucle.
const limiterCommun = {
  windowMs: 60 * 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez dans une minute' },
};
const generalLimiter = rateLimit({ ...limiterCommun, limit: 300 });
// Bucket beaucoup plus serré sur les écritures : une création de commande écrit
// en base et un PaymentIntent est un appel Stripe facturé — sans plafond, un
// script en boucle génère du coût réel et pollue le tableau de bord pharmacie.
const writeLimiter = rateLimit({ ...limiterCommun, limit: 20 });

app.use(generalLimiter);

app.use('/auth', authRoutes);
// GET /orders est interrogé en continu par le dashboard pharmacie : seule la
// création est soumise au quota serré.
app.use('/orders', (req, res, next) => (req.method === 'POST' ? writeLimiter(req, res, next) : next()));
app.use('/orders', ordersRoutes);
app.use('/push', pushRoutes);
app.use('/payments/create-intent', writeLimiter);
app.use('/payments', paymentsRoutes); // /payments/create-intent

// ── Gestion d'erreurs générique ──
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

const server = http.createServer(app);
realtime.attach(server); // WebSocket /realtime — remplace sbSubscribeOrders

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Livraisanté backend démarré sur le port ${PORT} (${process.env.NODE_ENV || 'development'})`);
});

// Clever Cloud envoie SIGTERM à chaque redéploiement. Sans arrêt propre, les
// requêtes en cours sont coupées net : une commande peut être écrite en base
// sans que le patient reçoive sa réponse, et les connexions Postgres restent
// ouvertes côté serveur jusqu'à leur expiration.
let arretEnCours = false;
function arretPropre(signal) {
  if (arretEnCours) return;
  arretEnCours = true;
  console.log(`${signal} reçu — arrêt propre en cours…`);

  // Délai de grâce : si une requête reste bloquée, on ne retient pas le
  // déploiement indéfiniment.
  const couperCourt = setTimeout(() => {
    console.error('Arrêt propre trop long — sortie forcée');
    process.exit(1);
  }, 10000);
  couperCourt.unref();

  server.close(async () => {
    try { await prisma.$disconnect(); } catch (_) { /* déjà fermé */ }
    try { await pool.end(); } catch (_) { /* déjà fermé */ }
    process.exit(0);
  });
}
process.on('SIGTERM', () => arretPropre('SIGTERM'));
process.on('SIGINT', () => arretPropre('SIGINT'));
