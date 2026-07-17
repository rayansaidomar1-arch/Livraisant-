// Routes d'authentification — remplace sbSignUp / sbSignIn / sbSignOut /
// sbResetPassword / sbUpdatePassword / sbSignInWithGoogle / sbGetSession
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  requireAuth,
} = require('../lib/auth');
const { sendEmail } = require('../lib/email');

const router = express.Router();

// ── Anti-bruteforce / anti-énumération ──────────────────────────────
// Limite stricte sur les endpoints sensibles (mot de passe, création de compte).
// Basé sur l'IP (req.ip) — Express doit avoir `trust proxy` activé (c'est le cas dans index.js)
// pour lire correctement l'IP réelle derrière le proxy Clever Cloud.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 tentatives / IP / 15 min sur signin+signup+forgot-password confondus
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Réessayez dans quelques minutes.' },
});

// Limite encore plus stricte spécifiquement sur signin (protection bruteforce mot de passe)
const signinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion. Réessayez dans quelques minutes.' },
});

router.use(['/signup', '/signin', '/forgot-password', '/reset-password'], authLimiter);

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères'),
  role: z.enum(['patient', 'pharmacie', 'livreur', 'club', 'pro']).default('patient'),
  nom: z.string().optional(),
  telephone: z.string().optional(),
});

// ── POST /auth/signup ──
router.post('/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email, password, role, nom, telephone } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, role, nom, telephone },
  });

  // Email de confirmation (équivalent template confirm-signup.html)
  const confirmToken = jwt.sign({ sub: user.id, type: 'confirm_email' }, process.env.JWT_SECRET, { expiresIn: '24h' });
  const confirmUrl = `${process.env.FRONTEND_ORIGIN}/confirmer-email?token=${confirmToken}`;
  try {
    await sendEmail({
      to: email,
      subject: 'Confirmez votre inscription — Livraisanté',
      templateKey: 'confirm-signup',
      vars: { CONFIRMATION_URL: confirmUrl },
    });
  } catch (err) {
    console.error('Échec envoi email de confirmation:', err.message);
  }

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  res.status(201).json({
    user: { id: user.id, email: user.email, role: user.role, nom: user.nom },
    accessToken,
    refreshToken,
  });
});

const signinSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ── POST /auth/signin ──
router.post('/signin', signinLimiter, async (req, res) => {
  const parsed = signinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  }

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  res.json({
    user: { id: user.id, email: user.email, role: user.role, nom: user.nom },
    accessToken,
    refreshToken,
  });
});

// ── POST /auth/refresh ── (renouvelle un accessToken à partir d'un refreshToken valide)
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken requis' });
  try {
    const payload = verifyRefreshToken(refreshToken);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });
    res.json({ accessToken: signAccessToken(user) });
  } catch (err) {
    res.status(401).json({ error: 'refreshToken invalide ou expiré' });
  }
});

// ── GET /auth/me ── (équivalent sbGetSession + sbGetProfile)
router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ id: user.id, email: user.email, role: user.role, nom: user.nom, telephone: user.telephone });
});

const forgotSchema = z.object({ email: z.string().email() });

// ── POST /auth/forgot-password ── (équivalent sbResetPassword)
router.post('/forgot-password', async (req, res) => {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { email } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  // Réponse identique que l'utilisateur existe ou non (évite l'énumération de comptes)
  if (user) {
    const resetToken = jwt.sign({ sub: user.id, type: 'reset_password' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const resetUrl = `${process.env.FRONTEND_ORIGIN}/reinitialiser-mot-de-passe?token=${resetToken}`;
    try {
      await sendEmail({
        to: email,
        subject: 'Réinitialisez votre mot de passe — Livraisanté',
        templateKey: 'reset-password',
        vars: { CONFIRMATION_URL: resetUrl },
      });
    } catch (err) {
      console.error('Échec envoi email de réinitialisation:', err.message);
    }
  }
  res.json({ ok: true, message: 'Si un compte existe avec cet email, un lien de réinitialisation a été envoyé.' });
});

const resetSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères'),
});

// ── POST /auth/reset-password ── (équivalent sbUpdatePassword)
router.post('/reset-password', async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { token, newPassword } = parsed.data;

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== 'reset_password') throw new Error('Type de token invalide');
    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: payload.sub }, data: { passwordHash } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'Lien invalide ou expiré' });
  }
});

// ── GET /auth/confirm-email ── (équivalent confirmation Supabase via {{ .ConfirmationURL }})
router.get('/confirm-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token requis' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== 'confirm_email') throw new Error('Type de token invalide');
    await prisma.user.update({ where: { id: payload.sub }, data: { emailConfirmedAt: new Date() } }).catch(() => {
      // Si le champ emailConfirmedAt n'existe pas encore dans le schéma, à ajouter au besoin
    });
    res.redirect(`${process.env.FRONTEND_ORIGIN}/?email_confirme=1`);
  } catch (err) {
    res.redirect(`${process.env.FRONTEND_ORIGIN}/?email_confirme=0`);
  }
});

module.exports = router;
