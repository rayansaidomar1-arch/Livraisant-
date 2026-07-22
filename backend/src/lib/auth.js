// ═══════════════════════════════════════════════════════════════════════
// Vérification des JWT émis par Supabase Auth (architecture hybride —
// Supabase reste l'unique fournisseur d'identité, ce backend ne gère plus
// signup/signin/mot de passe/OAuth lui-même : tout ça est déjà couvert
// nativement par Supabase Auth côté client, via js/supabase-client.js).
//
// Clés de signature ES256 asymétriques → vérification via l'endpoint JWKS
// public (SUPABASE_JWKS_URL), pas de secret partagé à conserver ici.
//
// IMPORTANT (sécurité) : on ne fait JAMAIS confiance à un rôle porté par
// le JWT (`user_metadata.role` est modifiable par l'utilisateur lui-même
// via supabase.auth.updateUser — c'est exactement la faille d'escalade de
// rôle corrigée côté Supabase le 17/07/2026, cf. handle_new_user /
// prevent_role_self_escalation dans supabase/migrations). Le rôle
// applicatif est systématiquement relu depuis `profiles` (Supabase),
// seule source de vérité, via attachProfile/requireRole ci-dessous.
// ═══════════════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { getProfile } = require('./supabaseDb');

const client = jwksClient({
  jwksUri: process.env.SUPABASE_JWKS_URL,
  cache: true,
  cacheMaxAge: 10 * 60 * 1000,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getSigningKey, { algorithms: ['ES256', 'RS256'] }, (err, decoded) => {
      if (err) return reject(err);
      resolve(decoded);
    });
  });
}

/** Middleware Express : exige un JWT Supabase valide, attache req.user = { id, email }. */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const decoded = await verifyToken(token);
    req.user = { id: decoded.sub, email: decoded.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

/** Comme requireAuth mais n'échoue pas si le token est absent/invalide. */
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  try {
    const decoded = await verifyToken(token);
    req.user = { id: decoded.sub, email: decoded.email };
  } catch (_) { /* ignore */ }
  next();
}

/**
 * Charge le profil (dont le rôle faisant autorité) depuis Supabase et
 * l'attache à req.profile. À utiliser après requireAuth.
 */
async function attachProfile(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const profile = await getProfile(req.user.id);
    if (!profile) return res.status(404).json({ error: 'Profil introuvable' });
    req.profile = profile;
    req.user.role = profile.role; // pratique pour les routes qui lisent req.user.role
    next();
  } catch (err) {
    next(err);
  }
}

/** Middleware : exige que le rôle en base Supabase (jamais celui du JWT) soit autorisé. */
function requireRole(...roles) {
  return [
    attachProfile,
    (req, res, next) => {
      if (!roles.includes(req.profile.role)) return res.status(403).json({ error: 'Accès refusé' });
      next();
    },
  ];
}

module.exports = { requireAuth, optionalAuth, attachProfile, requireRole, verifyToken };
