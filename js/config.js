/**
 * Livraisanté — Configuration production
 * ⚠️  Ce fichier contient uniquement des clés PUBLIQUES (safe to expose in git).
 * Les clés SECRÈTES (Stripe secret, Supabase service_role) vont dans
 * les variables d'env Supabase Edge Functions (supabase secrets set ...).
 */
window.LIVR_CONFIG = {
  // ── Supabase (https://supabase.com/dashboard → Settings → API) ─────
  // Mettre à jour lors de la migration Clever Cloud
  supabase_url:  'https://gsmrgafclxkuqzzhtapi.supabase.co',
  supabase_anon: 'sb_publishable_lkkWiVC0Zs59wv7WBqGiuQ_XKIarkBc',

  // ── Stripe (https://dashboard.stripe.com/apikeys) ──────────────────
  stripe_pk: 'pk_live_51TlGbmACKGmHTUUGH77rzrcCUd7ALnHKu9ZqIwmX3gtjuzbMAldFb2mCg7MdFUXMcPzCiDkOJ1UYsTK4JODSK7aJ00BDwgXD9H',

  // ── Google Analytics 4 (https://analytics.google.com) ─────────────
  // Chargé dynamiquement après consentement cookies CNIL
  ga4_id: 'G-HL89CPZ6YL',

  // ── Plausible (https://plausible.io/sites) ─────────────────────────
  // Conforme RGPD sans cookie — actif sans configuration supplémentaire
  plausible_domain: 'livraisante.fr',

  // ── Sentry (https://sentry.io) ─────────────────────────────────────
  // Monitoring erreurs production — laisser vide pour désactiver
  sentry_dsn: '',
};
