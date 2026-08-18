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
const { getProfile, hasVerifiedMfaFactor } = require('./supabaseDb');

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
    // `aal` : niveau d'assurance de la session (aal1 = mot de passe seul,
    // aal2 = second facteur présenté). Exploité par requireAal2 ci-dessous.
    req.user = { id: decoded.sub, email: decoded.email, aal: decoded.aal || 'aal1' };
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
    // `aal` : niveau d'assurance de la session (aal1 = mot de passe seul,
    // aal2 = second facteur présenté). Exploité par requireAal2 ci-dessous.
    req.user = { id: decoded.sub, email: decoded.email, aal: decoded.aal || 'aal1' };
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

/**
 * Middleware : exige le second facteur sur les routes de données de santé.
 *
 * La 2FA étant optionnelle (choix produit : pas de friction à l'inscription),
 * exiger `aal2` de tout le monde couperait l'accès des patients qui ne l'ont
 * pas activée. On n'exige donc le second facteur qu'aux comptes qui en ont
 * réellement un : dès qu'un patient active la 2FA, son dossier de santé
 * devient inaccessible sans le code — y compris depuis un token volé émis
 * avant l'élévation.
 *
 * Le code `mfa_required` permet au front de déclencher l'écran d'élévation
 * (mfaPromptStepUp) plutôt que d'afficher une erreur générique.
 * En cas d'indisponibilité de la base Supabase on échoue en fermé : sur des
 * données de santé, mieux vaut refuser que servir sans vérification.
 */
async function requireAal2(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Non authentifié' });
  try {
    if (!(await needsMfaStepUp(req.user))) return next();
  } catch (err) {
    console.error('requireAal2 — lecture auth.mfa_factors impossible', err);
    return res.status(503).json({ error: 'Vérification de sécurité indisponible. Réessayez dans un instant.' });
  }
  return res.status(403).json({
    error: 'Double authentification requise pour accéder à vos données de santé.',
    code: 'mfa_required',
  });
}

/**
 * Prédicat sous-jacent à requireAal2, utilisable par les routes qui doivent
 * dégrader plutôt que refuser (ex. /auth/me, qui doit rester joignable pour
 * afficher l'identité même sans second facteur, mais sans le dossier santé).
 */
async function needsMfaStepUp(user) {
  if (user.aal === 'aal2') return false;
  return hasVerifiedMfaFactor(user.id);
}

module.exports = {
  requireAuth, optionalAuth, attachProfile, requireRole,
  requireAal2, needsMfaStepUp, verifyToken,
};
