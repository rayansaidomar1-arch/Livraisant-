-- ============================================================================
-- Correctif audit 2026-08-05 (Critique #3) — vérification d'inscription réelle
-- ============================================================================
-- Avant ce correctif, l'étape « vérification en 2 étapes » de l'inscription
-- (index.html, doRegister()/showVerificationPanel()/confirmVerification()) était
-- entièrement fictive : generateCode() générait deux codes à 6 chiffres côté
-- client, jamais envoyés par email ni SMS, et confirmVerification() comparait
-- la saisie de l'utilisateur à ces mêmes valeurs conservées en mémoire côté
-- client (variable `pendingReg`) — trivialement lisible/contournable via les
-- DevTools. Aucune preuve réelle que l'email appartient à l'utilisateur.
--
-- Cette table stocke désormais un code envoyé pour de vrai par email (via
-- l'Edge Function `send-email`, type `signup_verification`, Resend), et
-- vérifié côté serveur par une nouvelle Edge Function `signup-verification`
-- (SERVICE_ROLE, jamais exposée au client autrement que via ces deux actions).
-- Le code n'est jamais stocké en clair (seul son hash SHA-256 l'est), avec
-- expiration et compteur de tentatives pour limiter le brute-force d'un code
-- à 6 chiffres.
--
-- La vérification SMS/téléphone est retirée : aucun fournisseur SMS n'existe
-- dans ce projet (aucune intégration Twilio/Vonage/etc.), donc l'ancien champ
-- « code SMS » était doublement fictif (jamais envoyé, et rien ne pourrait
-- l'envoyer). Le téléphone reste un champ informatif, non vérifié.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.signup_verifications (
  email text PRIMARY KEY,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS activée sans aucune policy : seule l'Edge Function `signup-verification`
-- (SERVICE_ROLE_KEY, bypass RLS) peut lire/écrire cette table — jamais un
-- client anonyme ou authentifié directement. Même pattern que
-- `rate_limit_hits` (migration 20260723000002).
ALTER TABLE public.signup_verifications ENABLE ROW LEVEL SECURITY;

-- Nettoyage paresseux des lignes expirées depuis longtemps (évite que la table
-- grossisse indéfiniment) — appelée par l'Edge Function avant chaque envoi,
-- pas de cron nécessaire vu le volume actuel du site.
CREATE OR REPLACE FUNCTION public.cleanup_expired_signup_verifications()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.signup_verifications WHERE expires_at < now() - interval '1 day';
$$;
