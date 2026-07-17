// Routes commandes — remplace sbGetOrders / sbInsertOrder / sbUpdateOrderStatus / sbSubscribeOrders
const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../lib/auth');
const { sendPushToUser } = require('../lib/push');
const { sendEmail } = require('../lib/email');
const { broadcast } = require('../lib/realtime');

const router = express.Router();

// ── GET /orders ── (scope selon le rôle, équivalent des policies RLS orders_*) ──
router.get('/', requireAuth, async (req, res) => {
  const { id: userId, role } = req.user;

  if (role === 'patient') {
    const orders = await prisma.order.findMany({ where: { patientId: userId }, orderBy: { createdAt: 'desc' } });
    return res.json(orders);
  }

  if (role === 'pharmacie') {
    const pharmacy = await prisma.pharmacy.findUnique({ where: { userId } });
    if (!pharmacy) return res.json([]);
    const orders = await prisma.order.findMany({ where: { pharmacyId: pharmacy.id }, orderBy: { createdAt: 'desc' } });
    return res.json(orders);
  }

  if (role === 'livreur') {
    const driver = await prisma.driver.findUnique({ where: { userId } });
    if (!driver || !driver.active) return res.json([]);
    const orders = await prisma.order.findMany({
      where: { status: { in: ['validee', 'prete', 'en_livraison'] } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(orders);
  }

  return res.status(403).json({ error: 'Rôle non autorisé à consulter les commandes' });
});

const createOrderSchema = z.object({
  pharmacyId: z.string().uuid().optional(),
  items: z.any().optional(),
  kind: z.string().optional(),
  trackId: z.string().optional(),
  totalEur: z.number().nonnegative().optional(),
  patientSnapshot: z.any().optional(),
});

// ── POST /orders ── (équivalent sbInsertOrder — réservé aux patients) ──
router.post('/', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ error: 'Seuls les patients peuvent créer une commande' });
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const order = await prisma.order.create({
    data: {
      patientId: req.user.id,
      pharmacyId: parsed.data.pharmacyId,
      items: parsed.data.items,
      kind: parsed.data.kind,
      trackId: parsed.data.trackId,
      totalEur: parsed.data.totalEur,
      patientSnapshot: parsed.data.patientSnapshot,
    },
  });

  if (order.pharmacyId) broadcast(`orders:pharmacy:${order.pharmacyId}`, 'insert', order);
  res.status(201).json(order);
});

const statusSchema = z.object({
  status: z.enum(['en_attente', 'validee', 'prete', 'en_livraison', 'livree', 'refusee']),
});

// ── PATCH /orders/:id/status ── (équivalent sbUpdateOrderStatus) ──
router.patch('/:id/status', requireAuth, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { id } = req.params;
  const { status } = parsed.data;
  const { id: userId, role } = req.user;

  const order = await prisma.order.findUnique({ where: { id }, include: { pharmacy: true } });
  if (!order) return res.status(404).json({ error: 'Commande introuvable' });

  // Autorisation : pharmacie propriétaire, ou livreur actif (pour prise en charge/livraison)
  if (role === 'pharmacie') {
    if (!order.pharmacy || order.pharmacy.userId !== userId) return res.status(403).json({ error: 'Accès refusé' });
  } else if (role === 'livreur') {
    const driver = await prisma.driver.findUnique({ where: { userId } });
    if (!driver || !driver.active) return res.status(403).json({ error: 'Accès refusé' });
  } else {
    return res.status(403).json({ error: 'Rôle non autorisé à modifier le statut' });
  }

  const updated = await prisma.order.update({ where: { id }, data: { status } });

  // ── Déclenchement email + push "commande en préparation" quand la pharmacie valide ──
  if (status === 'validee') {
    const patient = await prisma.user.findUnique({ where: { id: updated.patientId } });
    const pharmacyNom = order.pharmacy?.nom || 'votre pharmacie';
    const snapshot = updated.patientSnapshot || {};
    const medicaments = Array.isArray(updated.items)
      ? updated.items.map((it) => `${it.qty || 1}x ${it.nom || it.name || ''}`).join('\n')
      : (typeof updated.items === 'string' ? updated.items : 'Médicaments sur ordonnance');

    if (patient?.email) {
      sendEmail({
        to: patient.email,
        subject: '🔄 Votre commande est en préparation — Livraisanté',
        templateKey: 'preparation',
        vars: {
          PATIENT_NOM: patient.nom || 'cher client',
          PHARMACY_NOM: pharmacyNom,
          MEDICAMENTS: medicaments,
          MONTANT: updated.totalEur ? `€${Number(updated.totalEur).toFixed(2)}` : '—',
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
  broadcast('orders:driver', 'update', updated);

  res.json(updated);
});

module.exports = router;
