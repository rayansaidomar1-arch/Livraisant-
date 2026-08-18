// ═══════════════════════════════════════════════════════════════════════
// Accès en LECTURE SEULE à la base Supabase — architecture hybride
// (2026-07-18) : profiles (identité + rôle), drivers, push_subscriptions,
// clubs, club_members, settlements, pharmacy_applications restent sur
// Supabase (protégés par leurs policies RLS pour l'accès direct client).
//
// Ce backend Clever Cloud a besoin d'y lire :
//   - profiles.role (source de vérité pour l'autorisation — jamais le JWT)
//   - profiles.email / nom / prenom (notifications email/push déclenchées
//     depuis les routes orders/payments, ex. confirmation de commande)
//   - drivers.active (un livreur ne peut consulter/prendre en charge des
//     commandes que si son compte livreur est actif)
//   - push_subscriptions (envoi de notifications push, cf. lib/push.js)
//
// Connexion directe Postgres (pas l'API REST Supabase) : plus simple ici
// car ce sont de simples lectures ponctuelles, et évite de dépendre d'une
// clé service_role supplémentaire à demander à l'utilisateur.
// ═══════════════════════════════════════════════════════════════════════
const { Pool } = require('pg');

// `rejectUnauthorized: false` acceptait n'importe quel certificat : un
// attaquant en position d'interception sur le trajet Clever Cloud → Supabase
// pouvait présenter le sien et lire/réécrire en clair les rôles et emails qui
// transitent ici. Supabase signe ses certificats avec sa propre autorité : on
// la fournit via SUPABASE_DB_CA (contenu PEM du certificat téléchargé depuis
// Settings → Database → SSL configuration) et on vérifie réellement la chaîne.
// Sans cette variable on refuse de dégrader silencieusement : le mode permissif
// doit rester un choix explicite et visible dans les logs.
const caCert = process.env.SUPABASE_DB_CA;
if (!caCert) {
  console.warn('⚠️  SUPABASE_DB_CA absente : la connexion Supabase ne vérifie pas le certificat serveur (MITM possible).');
}

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URI,
  ssl: caCert ? { ca: caCert, rejectUnauthorized: true } : { rejectUnauthorized: false },
  // Supabase plafonne le nombre de connexions par projet ; sans `max`, `pg`
  // en ouvre 10 par instance et un scale-up Clever Cloud épuise le quota.
  max: Number(process.env.SUPABASE_DB_POOL_MAX || 5),
  // Sans délai, une base injoignable laisse la requête (et la requête HTTP
  // qui l'attend) pendue indéfiniment.
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

// Une connexion inactive fermée par Supabase émet 'error' sur le pool. Sans
// écouteur, Node relance l'événement en exception non capturée et le process
// meurt — un simple recyclage de connexion côté Supabase suffisait à faire
// tomber le backend.
pool.on('error', (err) => console.error('Erreur pool Supabase:', err.message));

/** Retourne { id, email, prenom, nom, role } ou null. */
async function getProfile(userId) {
  const { rows } = await pool.query(
    'SELECT id, email, prenom, nom, role FROM profiles WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
}

/** true si l'utilisateur a un compte livreur actif (table drivers). */
async function isActiveDriver(userId) {
  const { rows } = await pool.query(
    'SELECT active FROM drivers WHERE user_id = $1',
    [userId]
  );
  return Boolean(rows[0]?.active);
}

/** Abonnements push d'un utilisateur (table push_subscriptions). */
async function getPushSubscriptions(userId) {
  const { rows } = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  return rows;
}

/** Supprime un abonnement push devenu invalide (410/404 côté navigateur). */
async function deletePushSubscription(id) {
  await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [id]);
}

/**
 * true si l'utilisateur a une double authentification réellement active.
 *
 * La 2FA est optionnelle : on ne peut donc pas exiger `aal2` de tout le monde
 * sans couper l'accès à ceux qui ne l'ont pas activée. Le middleware
 * requireAal2 (lib/auth.js) s'appuie sur cette lecture pour n'exiger le second
 * facteur qu'à ceux qui en possèdent un — et seulement un facteur `verified`,
 * un enrôlement abandonné restant en `unverified` ne doit rien verrouiller.
 */
async function hasVerifiedMfaFactor(userId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM auth.mfa_factors WHERE user_id = $1 AND status = 'verified' LIMIT 1",
    [userId]
  );
  return rows.length > 0;
}

module.exports = {
  pool,
  getProfile,
  isActiveDriver,
  getPushSubscriptions,
  deletePushSubscription,
  hasVerifiedMfaFactor,
};
