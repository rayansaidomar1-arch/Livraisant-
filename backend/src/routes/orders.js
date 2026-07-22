// ═══════════════════════════════════════════════════════════════════════
// Routes commandes — remplace sbGetOrders / sbInsertOrder / sbUpdateOrderStatus.
// Miroir des policies RLS orders_* (migrations 20260624000000 et
// 20260711000000 — flux livreur avec driver_id/claim). `drivers` et
// `profiles` restent sur Supabase (architecture hybride) : toute lecture
// de rôle/statut livreur passe par lib/supabaseDb.js, jamais par le JWT.
// ═══════════════════════════════════════════════════════════════════════
const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { requireAuth, attachProfile } = require('../lib/auth');
const { isActiveDriver, getProfile } = require('../lib/supabaseDb');
const { sendPushToUser } = require('../lib/push');
const { sendEmail } = require('../lib/email');
const { broadcast } = require('../lib/realtime');

const router = express.Router();

// ── GET /orders ── (scope selon le rôle Supabase, jamais celui du JWT) ──
router.get('/', requireAuth, attachProfile, async (req, res, next) => {
  try {
    const { id: userId, role } = req.user;

    if (role === 'patient' || role === 'patient_licencie') {
      const orders = await prisma.order.findMany({ where: { patientId: userId }, orderBy: { createdAt: 'desc' } });
      return res.json(orders);
    }

    if (role === 'pharmacien') {
      const pharmacy = await prisma.pharmacy.findUnique({ where: { userId } });
      if (!pharmacy) return res.json([]);
      const orders = await prisma.order.findMany({ where: { pharmacyId: pharmacy.id }, orderBy: { createdAt: 'desc' } });
      return res.json(orders);
    }

    if (role === 'livreur') {
      // Ses propres commandes prises en charge (détail complet).
      const mine = await prisma.order.findMany({ where: { driverId: userId }, orderBy: { createdAt: 'desc' } });
      // Commandes disponibles (non prises en charge) — colonnes limitées,
      // miroir de la vue orders_driver_available : pas de médicaments/adresse
      // tant que la commande n'est pas explicitement prise en charge.
      const available = await prisma.order.findMany({
        where: { driverId: null, status: { in: ['validee', 'prete'] } },
        select: { id: true, pharmacyId: true, status: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      return res.json({ mine, available });
    }

    return res.status(403).json({ error: 'Rôle non autorisé à consulter les commandes' });
  } catch (err) {
    next(err);
  }
});

const createOrderSchema = z.object({
  pharmacyId: z.string().uuid().optional(),
  items: z.any().optional(),
  kind: z.string().optional(),
  trackId: z.string().optional(),
  totalPrice: z.number().nonnegative().optional(),
  deliveryFee: z.number().nonnegative().optional(),
  patientSnapshot: z.any().optional(),
});

// ── POST /orders ── (équivalent sbInsertOrder — réservé aux patients) ──
router.post('/', requireAuth, attachProfile, async (req, res, next) => {
  if (!['patient', 'patient_licencie'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Seuls les patients peuvent créer une commande' });
  }
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const order = await prisma.order.create({
      data: {
        patientId: req.user.id,
        pharmacyId: parsed.data.pharmacyId,
        items: parsed.data.items,
        kind: parsed.data.kind,
        trackId: parsed.data.trackId,
        totalPrice: parsed.data.totalPrice,
        deliveryFee: parsed.data.deliveryFee,
        patientSnapshot: parsed.data.patientSnapshot,
      },
    });

    if (order.pharmacyId) broadcast(`orders:pharmacy:${order.pharmacyId}`, 'insert', order);
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

// ── POST /orders/:id/claim ── (livreur : prise en charge atomique) ──
// Miroir de la policy "orders_driver_claim" : driver actif (Supabase)
// requis, commande non assignée et dans un statut compatible.
router.post('/:id/claim', requireAuth, attachProfile, async (req, res, next) => {
  if (req.user.role !== 'livreur') return res.status(403).json({ error: 'Accès réservé aux livreurs' });
  try {
    const active = await isActiveDriver(req.user.id);
    if (!active) return res.status(403).json({ error: 'Compte livreur inactif' });

    const { count } = await prisma.order.updateMany({
      where: { id: req.params.id, driverId: null, status: { in: ['validee', 'prete'] } },
      data: { driverId: req.user.id },
    });
    if (!count) return res.status(409).json({ error: 'Commande indisponible ou déjà prise en charge' });

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    broadcast('orders:driver', 'update', order);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

const statusSchema = z.object({
  status: z.enum(['en_attente', 'validee', 'prete', 'en_livraison', 'livree', 'refusee']),
});

// ── PATCH /orders/:id/status ── (pharmacie propriétaire, ou livreur assigné) ──
router.patch('/:id/status', requireAuth, attachProfile, async (req, res, next) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { id } = req.params;
  const { status } = parsed.data;
  const { id: userId, role } = req.user;

  try {
    const order = await prisma.order.findUnique({ where: { id }, include: { pharmacy: true } });
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    if (role === 'pharmacien') {
      if (!order.pharmacy || order.pharmacy.userId !== userId) return res.status(403).json({ error: 'Accès refusé' });
    } else if (role === 'livreur') {
      if (order.driverId !== userId) return res.status(403).json({ error: 'Accès refusé' });
    } else {
      return res.status(403).json({ error: 'Rôle non autorisé à modifier le statut' });
    }

    const updated = await prisma.order.update({ where: { id }, data: { status } });

    // ── Email + push "commande en préparation" quand la pharmacie valide ──
    if (status === 'validee') {
      const patientProfile = await getProfile(updated.patientId).catch(() => null);
      const pharmacyNom = order.pharmacy?.nom || 'votre pharmacie';
      const snapshot = updated.patientSnapshot || {};
      const medicaments = Array.isArray(updated.items)
        ? updated.items.map((it) => `${it.qty || 1}x ${it.nom || it.name || ''}`).join('\n')
        : (typeof updated.items === 'string' ? updated.items : 'Médicaments sur ordonnance');

      if (patientProfile?.email) {
        sendEmail({
          to: patientProfile.email,
          subject: '🔄 Votre commande est en préparation — Livraisanté',
          templateKey: 'preparation',
          vars: {
            PATIENT_NOM: patientProfile.nom || 'cher client',
            PHARMACY_NOM: pharmacyNom,
            MEDICAMENTS: medicaments,
            MONTANT: updated.totalPrice ? `€${Number(updated.totalPrice).toFixed(2)}` : '—',
            ADRESSE: snapshot.adresse || 'votre adresse enregistrée',
            ORDER_REF: updated.id.slice(0, 8).toUpperCase(),
            DATE: new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }),
          },
        }).catch((err) => console.error('Échec email préparation:', err.message));
      }

      sendPushToUser(updated.patientId, {
        title: '🔄 Commande en préparation',
        body: `${pharmacyNom} prépare votre commande.`,
        url: '/#commandes',
      }).catch((err) => console.error('Échec push préparation:', err.message));
    }

    if (order.pharmacyId) broadcast(`orders:pharmacy:${order.pharmacyId}`, 'update', updated);
    broadcast(`orders:patient:${updated.patientId}`, 'update', updated);
    if (role === 'livreur') broadcast('orders:driver', 'update', updated);

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
