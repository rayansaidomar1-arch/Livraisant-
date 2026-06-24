/**
 * Livraisanté — Configuration production
 * ⚠️  Remplacer les valeurs PLACEHOLDER par vos vraies clés.
 * Ce fichier contient uniquement des clés PUBLIQUES (safe to expose in git).
 * Les clés SECRÈTES (Stripe secret, Supabase service_role) vont dans
 * les variables d'env Supabase Edge Functions (supabase secrets set ...).
 */
window.LIVR_CONFIG = {
  // ── Stripe (https://dashboard.stripe.com/apikeys) ──────────────────
  // Remplacer par votre clé publique "pk_live_..." UNIQUEMENT
  stripe_pk: 'pk_live_VOTRE_CLE_STRIPE_ICI',

  // ── Google Analytics 4 (https://analytics.google.com) ─────────────
  // Chargé dynamiquement après consentement cookies CNIL
  ga4_id: 'G-XXXXXXXXXX',

  // ── Plausible (https://plausible.io/sites) ─────────────────────────
  // Conforme RGPD sans cookie — pas de consentement requis
  plausible_domain: 'livraisante.fr',
};
