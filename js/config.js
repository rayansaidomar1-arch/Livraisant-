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

  // ── Web Push VAPID (notifications push) ────────────────────────────
  // Clé publique uniquement. La clé privée correspondante vit désormais à DEUX
  // endroits qui doivent rester synchronisés avec cette valeur : les secrets
  // Supabase (Edge Function send-push) et les variables Clever Cloud (backend
  // HDS). En changer une sans les autres dépareille la paire : l'import de clé
  // échoue côté serveur et plus aucune notification ne part.
  vapid_public_key: 'BPUX2OGu5sonn2IfsUXS_RGKdqLrtzdKOHK-7wpHEiBBWcpliuJaiWxLSrnLPgSRus1lrXqLY5DLJ-gWoIijBZg',

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
  sentry_dsn: 'https://cf94e7eff1ee439cedbd7e349578e12f@o4511650891890688.ingest.de.sentry.io/4511650905391184',
};
