-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — Correctif contrainte profiles_role_check (2026-07-18)
--
-- Contexte : découvert en test pré-déploiement — toute inscription d'un
-- patient licencié sportif échouait avec un 500 sur /auth/v1/signup.
-- Cause : le trigger handle_new_user autorise 'patient_licencie' (voir
-- migration 20260717000000), mais la contrainte CHECK profiles_role_check
-- (créée via Dashboard, hors dépôt) ne l'inclut pas dans sa liste de
-- valeurs autorisées → l'INSERT du trigger échoue, ce qui fait échouer
-- l'inscription tout entière (auth.users + profiles étant liés par
-- trigger, l'échec du trigger fait échouer le signUp côté client).
--
-- Correctif : recrée la contrainte avec la liste complète des rôles
-- réellement utilisés par l'application (cf. index.html).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role = ANY (ARRAY['patient','patient_licencie','pharmacien','livreur','professionnel_sante','club','admin']));
