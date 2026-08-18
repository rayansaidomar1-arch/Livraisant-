// ═══════════════════════════════════════════════════════════════════════
// Auth — architecture hybride : Supabase Auth reste l'unique fournisseur
// d'identité (signup/signin/mot de passe/OAuth Google/confirmation email
// sont déjà gérés nativement par js/supabase-client.js via sb.auth.*).
//
// Ce backend n'expose donc plus de routes signup/signin/refresh/forgot-
// password/reset-password/confirm-email — elles duplicaient un flux que
// Supabase gère déjà correctement (et de façon plus sûre, cf. les
// migrations RLS déjà en place : handle_new_user, prevent_role_self_
// escalation). Restent ici uniquement :
//   - GET  /auth/me            → identité + profil santé fusionnés
//   - GET  /auth/health-profile
//   - PUT  /auth/health-profile → lit/écrit health_profiles (Clever Cloud),
//     qui remplace les colonnes profiles.health_profile / sport_license
//     (déplacées hors de Supabase car données de santé sensibles).
// ═══════════════════════════════════════════════════════════════════════
const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { requireAuth, attachProfile, requireAal2, needsMfaStepUp } = require('../lib/auth');

const router = express.Router();

// ── GET /auth/me ── identité Supabase (profiles) + profil santé (Clever Cloud)
// Cette route doit rester joignable même sans second facteur (le front en a
// besoin pour afficher l'identité et proposer l'élévation) : on ne refuse donc
// pas, on retire seulement le dossier de santé de la réponse.
router.get('/me', requireAuth, attachProfile, async (req, res, next) => {
  try {
    const mfaRequired = await needsMfaStepUp(req.user);
    const healthProfile = mfaRequired
      ? null
      : await prisma.healthProfile.findUnique({ where: { userId: req.user.id } });
    res.json({
      id: req.profile.id,
      email: req.profile.email,
      prenom: req.profile.prenom,
      nom: req.profile.nom,
      role: req.profile.role,
      healthProfile: healthProfile || null,
      mfaRequired,
    });
  } catch (err) {
    next(err);
  }
});

const healthProfileSchema = z.object({
  ageRange: z.string().optional(),
  pregnancy: z.string().optional(),
  sex: z.string().optional(),
  meds: z.any().optional(),
  weight: z.number().optional(),
  height: z.number().optional(),
  bmi: z.number().optional(),
  address: z.string().optional(),
  sportLicense: z.string().optional(),
});

// ── GET /auth/health-profile ── (équivalent profiles.health_profile / sport_license)
router.get('/health-profile', requireAuth, requireAal2, async (req, res, next) => {
  try {
    const profile = await prisma.healthProfile.findUnique({ where: { userId: req.user.id } });
    res.json(profile || null);
  } catch (err) {
    next(err);
  }
});

// ── PUT /auth/health-profile ── (upsert, propriétaire uniquement — pas d'admin
// bypass ici : ce sont des données de santé, seul le patient concerné les modifie)
router.put('/health-profile', requireAuth, requireAal2, async (req, res, next) => {
  const parsed = healthProfileSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  try {
    const data = parsed.data;
    const profile = await prisma.healthProfile.upsert({
      where: { userId: req.user.id },
      update: data,
      create: { userId: req.user.id, ...data },
    });
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
