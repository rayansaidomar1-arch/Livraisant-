-- ============================================================================
-- Branchement du stockage hors-local (2026-07-21, suite) :
--  1. Colonne fourre-tout `pharmacies.extra_settings` pour les réglages
--     pharmacien qui n'ont pas de colonne dédiée (horaires Google, motif
--     d'affluence, conseils personnalisés) — évite de multiplier les
--     migrations de schéma pour chaque nouveau réglage, tout en gardant les
--     lectures front-end (objets plats en camelCase) inchangées.
--  2. `is_admin()` — fonction SECURITY DEFINER utilisée comme prédicat RLS.
--     Nécessaire pour toute policy d'admin qui doit lire `profiles` : une
--     policy self-referençant `profiles` directement (EXISTS (SELECT 1 FROM
--     profiles WHERE ...)) déclenche une ré-évaluation RLS sur la table
--     elle-même et peut lever "infinite recursion detected in policy for
--     relation profiles". La fonction SECURITY DEFINER contourne le
--     problème car elle s'exécute avec les droits du propriétaire (donc hors
--     RLS) — c'est le pattern recommandé par Supabase pour ce cas précis.
--  3. Policies de lecture admin manquantes sur profiles/drivers/settlements/
--     pharmacy_applications — sans elles, le dashboard admin.html ne peut
--     tout simplement pas afficher de vraies données (patients, livreurs,
--     règlements, candidatures) même avec un compte role='admin' valide.
-- ============================================================================

-- ── 1. Réglages pharmacien divers (JSONB fourre-tout) ─────────────────────
ALTER TABLE public.pharmacies
  ADD COLUMN IF NOT EXISTS extra_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── 2. Helper is_admin() (SECURITY DEFINER, search_path verrouillé) ───────
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ── 3. Policies de lecture admin ───────────────────────────────────────────
DROP POLICY IF EXISTS "profiles_admin_read" ON public.profiles;
CREATE POLICY "profiles_admin_read"
  ON public.profiles FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "drivers_admin_read" ON public.drivers;
CREATE POLICY "drivers_admin_read"
  ON public.drivers FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "settlements_admin_read" ON public.settlements;
CREATE POLICY "settlements_admin_read"
  ON public.settlements FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "pharmacy_applications_admin_read" ON public.pharmacy_applications;
CREATE POLICY "pharmacy_applications_admin_read"
  ON public.pharmacy_applications FOR SELECT
  USING (public.is_admin());
