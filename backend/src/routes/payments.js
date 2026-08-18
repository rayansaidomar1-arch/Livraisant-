// Routes paiement — remplace create-payment-intent + stripe-webhook (Edge Functions Deno)
const express = require('express');
const { z } = require('zod');
const Stripe = require('stripe');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../lib/auth');
const { sendPushToUser } = require('../lib/push');
const { sendEmail } = require('../lib/email');
const { broadcast } = require('../lib/realtime');
const { getProfile } = require('../lib/supabaseDb'); // profiles reste sur Supabase (architecture hybride)

const router = express.Router();
const webhookRouter = express.Router();

// Instanciation paresseuse : le SDK Stripe lève une exception dès le
// constructeur si la clé est absente, ce qui ferait planter tout le
// process au démarrage si STRIPE_SECRET_KEY n'est pas encore configurée
// côté Clever Cloud. On ne construit le client qu'au premier appel réel.
let stripe = null;
function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY absente des variables d\'environnement');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return stripe;
}

// ── POST /payments/create-intent ── (équivalent create-payment-intent) ──
//
// Le corps ne contient QUE l'identifiant de commande. Auparavant il portait
// aussi `amount` et `metadata` : comme le webhook se fie à `metadata.orderId`
// pour décider quelle commande valider, un client pouvait envoyer un montant
// libre (branche sans `orderId`, qui court-circuitait le contrôle de
// propriété) accompagné de `metadata:{orderId:"<commande d'autrui>"}` et faire
// valider n'importe quelle commande pour 0,50 €. La `metadata` est désormais
// intégralement construite ici.
const createIntentSchema = z.object({ orderId: z.string().uuid() });

router.post('/create-intent', requireAuth, async (req, res, next) => {
  const parsed = createIntentSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Commande invalide' });

  try {
    const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId } });
    // Même réponse qu'une commande inexistante : distinguer les deux cas
    // permettrait d'énumérer les commandes des autres patients.
    if (!order || order.patientId !== req.user.id) {
      return res.status(404).json({ error: 'Commande introuvable' });
    }
    if (order.status !== 'en_attente') {
      return res.status(409).json({ error: 'Cette commande n\'est plus en attente de paiement' });
    }

    const finalAmount = Math.round(Number(order.totalPrice || 0) * 100);
    if (finalAmount < 50) return res.status(400).json({ error: 'Montant minimum 0,50 €' });

    const paymentIntent = await getStripe().paymentIntents.create({
      amount: finalAmount,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { orderId: order.id, patientId: order.patientId, platform: 'livraisante' },
    }, { idempotencyKey: `intent_${order.id}_${finalAmount}` });

    res.json({ clientSecret: paymentIntent.client_secret, amountEur: finalAmount / 100 });
  } catch (err) {
    next(err);
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
    event = getStripe().webhooks.constructEvent(req.body, signature, webhookSecret);
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
          const order = await prisma.order.findUnique({ where: { id: orderId }, include: { pharmacy: true } });
          if (order) {
            // Le montant réellement débité doit correspondre à la commande.
            // Sans ce contrôle, un PaymentIntent créé par un autre chemin (ou
            // pour un autre montant) validerait quand même la commande.
            const attendu = Math.round(Number(order.totalPrice || 0) * 100);
            if (pi.amount !== attendu) {
              console.error(`Webhook: montant incohérent pour ${orderId} — payé ${pi.amount}, attendu ${attendu}`);
              break;
            }

            // Idempotence : Stripe rejoue ses webhooks. Sans cette garde, un
            // rejeu réécrirait status='validee' sur une commande déjà passée
            // en 'prete'/'en_livraison' (régression de statut) et renverrait
            // une seconde facture au patient.
            const { count } = await prisma.order.updateMany({
              where: { id: orderId, status: 'en_attente' },
              data: { status: 'validee' },
            });
            if (!count) {
              console.log(`Webhook: commande ${orderId} déjà traitée (statut ${order.status}) — rejeu ignoré`);
              break;
            }
            const updated = await prisma.order.findUnique({ where: { id: orderId } });

            if (order.patientId) {
              sendPushToUser(order.patientId, {
                title: '✅ Commande validée',
                body: `Votre paiement de ${(pi.amount / 100).toFixed(2)}€ a été accepté. Votre commande est en préparation.`,
                url: '/#commandes',
              }).catch((err) => console.error('Push échoué:', err.message));
            }

            // profiles reste sur Supabase (architecture hybride) — lecture directe.
            const patientProfile = await getProfile(order.patientId).catch(() => null);
            if (patientProfile?.email) {
              const montant = pi.amount / 100;
              const montantHT = (montant / 1.055).toFixed(2);
              const tva = (montant - Number(montantHT)).toFixed(2);
              sendEmail({
                to: patientProfile.email,
                subject: `✅ Commande validée — Facture #${orderId.slice(0, 8).toUpperCase()} — Livraisanté`,
                templateKey: 'validation',
                vars: {
                  PATIENT_NOM: patientProfile.nom || 'pour votre confiance',
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
            // Idempotent : un rejeu ne doit pas renotifier le patient.
            const { count } = await prisma.order.updateMany({
              where: { id: orderId, status: { not: 'refusee' } },
              data: { status: 'refusee' },
            });
            if (!count) break;
            const updated = await prisma.order.findUnique({ where: { id: orderId } });
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
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = { router, webhookRouter };
