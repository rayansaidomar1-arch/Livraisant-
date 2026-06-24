/**
 * Livraisanté — Configuration production
 * ⚠️  Ce fichier contient uniquement des clés PUBLIQUES (safe to expose in git).
 * Les clés SECRÈTES (Stripe secret, Supabase service_role) vont dans
 * les variables d'env Supabase Edge Functions (supabase secrets set ...).
 */
window.LIVR_CONFIG = {
  // ── Stripe (https://dashboard.stripe.com/apikeys) ──────────────────
  // ⚠️  Remplacer par pk_live_... avant le lancement commercial
  stripe_pk: 'pk_test_51TlGbmACKGmHTUUGJfOl9c4BVCQ5m73Eo5kKE5O6fuVmy5lCd0pccHVbChoPU4vNPYN1vM8kdrnIhQ7QyQYJ9sDu00jZZjgHWf',

  // ── Google Analytics 4 (https://analytics.google.com) ─────────────
  // Chargé dynamiquement après consentement cookies CNIL
  // Remplacer G-XXXXXXXXXX par votre vrai Measurement ID quand disponible
  ga4_id: 'G-HL89CPZ6YL',

  // ── Plausible (https://plausible.io/sites) ─────────────────────────
  // Conforme RGPD sans cookie — actif sans configuration supplémentaire
  plausible_domain: 'livraisante.fr',
};
