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

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URI,
  ssl: { rejectUnauthorized: false },
});

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

module.exports = { pool, getProfile, isActiveDriver, getPushSubscriptions, deletePushSubscription };
