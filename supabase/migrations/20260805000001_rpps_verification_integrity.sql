-- ============================================================================
-- Correctif audit 2026-08-05 (Important #6) — vérification RPPS falsifiable
-- ============================================================================
-- Constat : `profiles.rpps_verified`/`rpps_status` (pharmaciens) étaient écrits
-- directement par le CLIENT via un appel authentifié classique
-- (sb.from('profiles').update({rpps_verified:true,...}) dans
-- completeRegistration(), index.html) — la policy "profiles_own_update"
-- (20260716000000) autorise déjà un utilisateur à modifier N'IMPORTE QUELLE
-- colonne de sa propre ligne, sans restriction de colonnes. Rien n'empêchait
-- un utilisateur connecté de rejouer cet appel à la main avec rpps_verified:true
-- sans jamais avoir réellement validé son RPPS (indépendamment du fait que la
-- valeur envoyée par le formulaire lui-même provenait d'une simple vérification
-- de FORMAT en cas d'échec de l'API — voir Edge Function verify-rpps).
--
-- Pour `health_professionals` (rôle professionnel_sante), c'était pire : la
-- policy "pros_own" est `FOR ALL USING (user_id = auth.uid())` sans WITH CHECK
-- — un professionnel pouvait directement s'auto-valider (`rpps_verified:true`)
-- dès l'INSERT initial de sa ligne, aucune vérification n'étant même tentée
-- côté formulaire pour ce rôle avant ce correctif.
--
-- Fix, même pattern que prevent_role_self_escalation (20260716000000) et
-- prevent_club_pro_tampering (20260723000001) : un trigger SECURITY DEFINER
-- qui neutralise tout changement de rpps_verified/rpps_status tant que
-- l'appelant n'est pas service_role (c-à-d. uniquement l'Edge Function
-- verify-rpps, jamais le navigateur). Si le numéro RPPS lui-même change, on
-- réinitialise honnêtement le statut à 'pending' plutôt que de le bloquer :
-- une correction de saisie ne doit pas conserver une vérification qui portait
-- sur un autre numéro.
-- ----------------------------------------------------------------------------

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rpps text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rpps_verified boolean NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rpps_status text NOT NULL DEFAULT 'pending';

ALTER TABLE health_professionals ADD COLUMN IF NOT EXISTS rpps_verified boolean NOT NULL DEFAULT false;
ALTER TABLE health_professionals ADD COLUMN IF NOT EXISTS rpps_status text NOT NULL DEFAULT 'pending';

-- 1. profiles (pharmaciens)
CREATE OR REPLACE FUNCTION public.prevent_rpps_self_verification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.rpps_verified := false;
    NEW.rpps_status := 'pending';
    RETURN NEW;
  END IF;
  IF NEW.rpps IS DISTINCT FROM OLD.rpps THEN
    NEW.rpps_verified := false;
    NEW.rpps_status := 'pending';
  ELSE
    NEW.rpps_verified := OLD.rpps_verified;
    NEW.rpps_status := OLD.rpps_status;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.prevent_rpps_self_verification() SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_prevent_rpps_self_verification ON public.profiles;
CREATE TRIGGER trg_prevent_rpps_self_verification
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_rpps_self_verification();

-- 2. health_professionals (autres professionnels de santé)
CREATE OR REPLACE FUNCTION public.prevent_pro_rpps_self_verification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.rpps_verified := false;
    NEW.rpps_status := 'pending';
    RETURN NEW;
  END IF;
  IF NEW.rpps IS DISTINCT FROM OLD.rpps THEN
    NEW.rpps_verified := false;
    NEW.rpps_status := 'pending';
  ELSE
    NEW.rpps_verified := OLD.rpps_verified;
    NEW.rpps_status := OLD.rpps_status;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.prevent_pro_rpps_self_verification() SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_prevent_pro_rpps_self_verification ON public.health_professionals;
CREATE TRIGGER trg_prevent_pro_rpps_self_verification
  BEFORE INSERT OR UPDATE ON public.health_professionals
  FOR EACH ROW EXECUTE FUNCTION public.prevent_pro_rpps_self_verification();
