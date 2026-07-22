-- ============================================================================
-- Livraisanté — Correctifs points bloquants + importants (2026-07-22)
--
-- Suite à l'audit du 2026-07-22 (branchement admin.html sur Supabase), quatre
-- trous ont été identifiés :
--
-- 1. Activation livreur : `drivers.active` vaut `false` par défaut, mais (a)
--    aucune interface admin ne permet de le passer à `true`, et (b) rien
--    n'empêchait un livreur de le positionner lui-même à `true` dès l'INSERT
--    initial (le trigger `prevent_driver_self_reactivation` du 2026-07-18 ne
--    couvre que les UPDATE, pas les INSERT). On corrige les deux : le trigger
--    couvre désormais aussi l'INSERT, et on ajoute une policy UPDATE dédiée à
--    l'admin pour que le futur écran d'activation fonctionne.
-- 2. `club_join_requests` : le code (index.html, `requestClubLiaison()`)
--    insère déjà dans cette table depuis longtemps ("best-effort, table may
--    not exist yet") mais elle n'a jamais été créée — toute demande de
--    liaison à un club non encore inscrit était donc silencieusement perdue.
-- 3. Codes promo : aucune table serveur n'existe. Le SPA (index.html) ET
--    admin.html ont chacun leur propre système 100% localStorage, avec des
--    clés différentes (`LS_PROMO_CODES` vs `livraisante_promo_codes`) — donc
--    même pas synchronisés entre eux. On crée une seule table Supabase
--    `promo_codes`, gérée par l'admin (RLS is_admin()), et une fonction
--    SECURITY DEFINER `redeem_promo_code()` pour la validation/consommation
--    côté patient/pharmacie sans jamais exposer la liste complète des codes.
-- 4. Stats d'usage (consultations, motifs d'abandon) : mesurées uniquement
--    en localStorage par navigateur, donc jamais visibles agrégées côté
--    admin. On ajoute une table `app_events` minimaliste pour centraliser ces
--    deux événements (les autres KPIs admin — patients/pharmacies/livreurs/
--    commandes/CA — sont déjà des vraies requêtes Supabase, voir
--    `loadAdminStats()` dans index.html).
-- ============================================================================

-- ── 1a. drivers.active — verrou étendu à l'INSERT + policy admin ──────────
CREATE OR REPLACE FUNCTION public.prevent_driver_self_activation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Seuls le service_role (Edge Functions/backoffice) ou un compte admin
  -- authentifié (via l'écran d'activation) peuvent positionner `active`.
  -- Un livreur qui s'auto-inscrit (INSERT) ne peut jamais forcer active=true.
  IF NEW.active = true AND auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    NEW.active := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_driver_self_activation ON public.drivers;
CREATE TRIGGER trg_prevent_driver_self_activation
  BEFORE INSERT ON public.drivers
  FOR EACH ROW EXECUTE FUNCTION public.prevent_driver_self_activation();

-- Le trigger UPDATE existant (2026-07-18) bloque tout le monde sauf
-- service_role ; on le remplace pour laisser passer l'admin aussi (sinon le
-- futur écran d'activation admin ne pourrait jamais réactiver un livreur).
CREATE OR REPLACE FUNCTION public.prevent_driver_self_reactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.active IS DISTINCT FROM OLD.active AND auth.role() <> 'service_role' AND NOT public.is_admin() THEN
    NEW.active := OLD.active;
  END IF;
  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS "drivers_admin_update" ON public.drivers;
CREATE POLICY "drivers_admin_update"
  ON public.drivers FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ── 2. club_join_requests (demandes de liaison à un club pas encore inscrit) ──
CREATE TABLE IF NOT EXISTS public.club_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  club_nom text NOT NULL,
  license_num text,
  patient_email text,
  patient_nom text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.club_join_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "club_join_requests_self_insert" ON public.club_join_requests;
CREATE POLICY "club_join_requests_self_insert"
  ON public.club_join_requests FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "club_join_requests_self_read" ON public.club_join_requests;
CREATE POLICY "club_join_requests_self_read"
  ON public.club_join_requests FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "club_join_requests_admin_read" ON public.club_join_requests;
CREATE POLICY "club_join_requests_admin_read"
  ON public.club_join_requests FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "club_join_requests_admin_update" ON public.club_join_requests;
CREATE POLICY "club_join_requests_admin_update"
  ON public.club_join_requests FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ── 3. promo_codes (table réelle + fonction de validation/consommation) ──
CREATE TABLE IF NOT EXISTS public.promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('percent','fixed')),
  value numeric NOT NULL DEFAULT 0,
  target text NOT NULL DEFAULT 'all' CHECK (target IN ('all','patient','pharmacie','livreur')),
  max_uses integer NOT NULL DEFAULT 0,
  used_count integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

-- Seul l'admin peut créer/lister/modifier/supprimer des codes directement.
-- Les patients/pharmacies ne lisent JAMAIS cette table : ils passent par la
-- fonction redeem_promo_code() ci-dessous (évite d'exposer la liste complète
-- des codes et les compteurs d'utilisation à n'importe quel compte).
DROP POLICY IF EXISTS "promo_codes_admin_all" ON public.promo_codes;
CREATE POLICY "promo_codes_admin_all"
  ON public.promo_codes FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE OR REPLACE FUNCTION public.redeem_promo_code(p_code text, p_role text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_promo public.promo_codes%ROWTYPE;
BEGIN
  SELECT * INTO v_promo FROM public.promo_codes
    WHERE upper(code) = upper(p_code) AND active = true
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','Code invalide ou expiré');
  END IF;
  IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < now() THEN
    RETURN jsonb_build_object('error','Code expiré');
  END IF;
  IF v_promo.max_uses > 0 AND v_promo.used_count >= v_promo.max_uses THEN
    RETURN jsonb_build_object('error','Code épuisé');
  END IF;
  IF v_promo.target <> 'all' AND v_promo.target <> p_role THEN
    RETURN jsonb_build_object('error','Code non applicable à ce type de compte');
  END IF;

  UPDATE public.promo_codes SET used_count = used_count + 1 WHERE id = v_promo.id;

  RETURN jsonb_build_object('promo', jsonb_build_object(
    'code', v_promo.code, 'type', v_promo.type, 'value', v_promo.value, 'target', v_promo.target
  ));
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_promo_code(text,text) TO authenticated, anon;

-- ── 4. app_events (mesure serveur des consultations / abandons) ──────────
CREATE TABLE IF NOT EXISTS public.app_events (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('consultation','abandon')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_events_self_insert" ON public.app_events;
CREATE POLICY "app_events_self_insert"
  ON public.app_events FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL AND (user_id = auth.uid() OR user_id IS NULL));

DROP POLICY IF EXISTS "app_events_admin_read" ON public.app_events;
CREATE POLICY "app_events_admin_read"
  ON public.app_events FOR SELECT
  USING (public.is_admin());
