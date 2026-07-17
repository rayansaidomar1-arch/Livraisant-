// Routes paiement — remplace create-payment-intent + stripe-webhook (Edge Functions Deno)
const express = require('express');
const Stripe = require('stripe');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../lib/auth');
const { sendPushToUser } = require('../lib/push');
const { sendEmail } = require('../lib/email');
const { broadcast } = require('../lib/realtime');

const router = express.Router();
const webhookRouter = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ── POST /payments/create-intent ── (équivalent create-payment-intent) ──
router.post('/create-intent', requireAuth, async (req, res) => {
  try {
    const { orderId, amount, currency = 'eur', metadata = {} } = req.body || {};
    let finalAmount;

    if (orderId) {
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return res.status(403).json({ error: 'Order not found' });
      // Le montant est calculé côté serveur depuis la commande — le client ne peut pas le falsifier
      if (order.patientId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
      finalAmount = Math.round(Number(order.totalEur || 0) * 100);
    } else {
      if (!amount || amount < 50) return res.status(400).json({ error: 'Montant minimum 0.50€' });
      finalAmount = Math.round(amount);
    }

    if (finalAmount < 50) return res.status(400).json({ error: 'Montant minimum 0.50€' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: finalAmount,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: { ...metadata, ...(orderId ? { orderId } : {}), platform: 'livraisante' },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /payments/webhook ── (équivalent stripe-webhook — appel serveur→serveur Stripe uniquement)
// IMPORTANT : ce routeur est monté séparément dans index.js, AVANT express.json(),
// avec express.raw({type:'application/json'}) car Stripe exige le corps brut pour vérifier la signature.
// Ne JAMAIS fusionner avec `router` (create-intent) qui a besoin du body JSON parsé classique.
webhookRouter.post('/', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('CRITICAL: STRIPE_WEBHOOK_SECRET non configuré');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  if (!signature) return res.status(400).json({ error: 'Missing stripe-signature header' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const orderId = pi.metadata?.orderId;
        if (orderId) {
          const order = await prisma.order.findUnique({ where: { id: orderId }, include: { pharmacy: true, patient: true } });
          if (order) {
            const updated = await prisma.order.update({
              where: { id: orderId },
              data: { status: 'validee' },
            });

            if (order.patientId) {
              sendPushToUser(order.patientId, {
                title: '✅ Commande validée',
                body: `Votre paiement de ${(pi.amount / 100).toFixed(2)}€ a été accepté. Votre commande est en préparation.`,
                url: '/#commandes',
              }).catch((err) => console.error('Push échoué:', err.message));
            }

            if (order.patient?.email) {
              const montant = pi.amount / 100;
              const montantHT = (montant / 1.055).toFixed(2);
              const tva = (montant - Number(montantHT)).toFixed(2);
              sendEmail({
                to: order.patient.email,
                subject: `✅ Commande validée — Facture #${orderId.slice(0, 8).toUpperCase()} — Livraisanté`,
                templateKey: 'validation',
                vars: {
                  PATIENT_NOM: order.patient.nom || 'pour votre confiance',
                  PHARMACY_NOM: order.pharmacy?.nom || '—',
                  MEDICAMENTS: typeof order.items === 'string' ? order.items : 'Médicaments',
                  ADRESSE: order.patientSnapshot?.adresse || '—',
                  ORDER_REF: orderId.slice(0, 8).toUpperCase(),
                  DATE: new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }),
                  MONTANT_HT: montantHT,
                  TVA: tva,
                  MONTANT_TTC: montant.toFixed(2),
                },
              }).catch((err) => console.error('Email validation échoué:', err.message));
            }

            if (order.pharmacyId) broadcast(`orders:pharmacy:${order.pharmacyId}`, 'update', updated);
            broadcast(`orders:patient:${order.patientId}`, 'update', updated);
          }
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const orderId = pi.metadata?.orderId;
        if (orderId) {
          console.log(`❌ Paiement échoué pour la commande ${orderId}: ${pi.last_payment_error?.message}`);
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const orderId = charge.metadata?.orderId;
        if (orderId) {
          const order = await prisma.order.findUnique({ where: { id: orderId } });
          if (order) {
            const updated = await prisma.order.update({ where: { id: orderId }, data: { status: 'refusee' } });
            sendPushToUser(order.patientId, {
              title: '↩️ Remboursement effectué',
              body: 'Votre commande a été annulée et remboursée.',
              url: '/#commandes',
            }).catch((err) => console.error('Push échoué:', err.message));
            broadcast(`orders:patient:${order.patientId}`, 'update', updated);
          }
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, webhookRouter };
