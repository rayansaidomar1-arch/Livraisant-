require('dotenv').config();
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const ordersRoutes = require('./routes/orders');
const { router: paymentsRoutes, webhookRouter: stripeWebhookRouter } = require('./routes/payments');
const pushRoutes = require('./routes/push');
const realtime = require('./lib/realtime');

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

app.use('/auth', authRoutes);
app.use('/orders', ordersRoutes);
app.use('/push', pushRoutes);
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
