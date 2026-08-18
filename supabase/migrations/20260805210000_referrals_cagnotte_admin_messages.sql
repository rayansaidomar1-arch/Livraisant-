-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — IMPORTANT #7 (2026-08-05) : parrainage livreur, cagnotte
-- club et messagerie admin passent d'un stockage 100% localStorage
-- (jamais synchronisé, jamais réel) à un stockage Supabase réel.
--
-- Constat d'audit :
--  1. Parrainage livreur : le code saisi par le filleul (`drRefCode`) n'était
--     jamais transmis nulle part — juste validé au format côté client avec
--     un message "le parrain sera notifié à ton activation" qui ne se
--     produisait jamais. Le compteur de gains affiché en profil lisait
--     `currentUser.driverInfo` — un champ jamais assigné dans tout le code
--     (toujours `undefined` → toujours 0 €, quoi qu'il arrive).
--  2. Cagnotte club : créditée côté client, dans le localStorage du PATIENT
--     (`livraisante_cagnotte_${clubId}`) — jamais vu par le club, ni par
--     l'admin, sur un autre appareil ou navigateur. Créditée en plus AVANT
--     confirmation réelle du paiement Stripe, sur un total non vérifié.
--  3. Messagerie admin : `sendAdminMessage()` écrivait uniquement dans le
--     localStorage du navigateur de l'admin. Aucun message n'était jamais
--     livré à un pharmacien/patient/club.
--
-- Correctifs (pattern déjà utilisé pour pricing/OTP/RPPS dans cette session:
-- calcul et persistance recalculés côté serveur, jamais fait confiance à un
-- champ client) :
--  - `drivers.referred_by_code` (déclaratif, sans risque financier direct :
--    ne débloque aucun crédit automatique) + RPC `my_driver_referral_stats()`
--    pour que chaque livreur voie le nombre RÉEL de filleuls inscrits/actifs
--    via son propre code, sans pouvoir lire les données d'un autre livreur.
--  - `club_cagnotte_entries` / `club_cagnotte_versements` : écriture
--    réservée au service_role (Edge Function confirm-order) + RPC
--    SECURITY DEFINER `verse_club_cagnotte()` pour le versement admin
--    (atomique : UPDATE...RETURNING, pas de race condition possible entre
--    deux appels concurrents).
--  - `admin_messages` : persistance réelle, lisible par les vrais
--    destinataires (scindés par rôle réel dans `profiles`, ou par
--    utilisateur précis) et par l'admin (historique envoyé).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Parrainage livreur ──────────────────────────────────────────────
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS referred_by_code text;

-- Un livreur ne peut lire/compter que SES PROPRES filleuls (ceux qui ont
-- saisi son `ref_code` à leur inscription) — jamais le détail des livreurs
-- d'un autre. SECURITY DEFINER pour éviter d'avoir à ouvrir une policy
-- SELECT cross-livreur sur `drivers` (qui exposerait IBAN/SIRET/adresse de
-- tout le monde à tout le monde).
CREATE OR REPLACE FUNCTION public.my_driver_referral_stats()
RETURNS TABLE(total_referred integer, total_active integer)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*)::int AS total_referred,
    count(*) FILTER (WHERE d.active)::int AS total_active
  FROM public.drivers d
  WHERE d.referred_by_code IS NOT NULL
    AND d.referred_by_code = (SELECT ref_code FROM public.drivers WHERE user_id = auth.uid())
    AND (SELECT ref_code FROM public.drivers WHERE user_id = auth.uid()) IS NOT NULL;
$$;

GRANT EXECUTE ON FUNCTION public.my_driver_referral_stats() TO authenticated;

-- ── 2. Cagnotte club ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.club_cagnotte_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  order_id text NOT NULL UNIQUE,
  patient_id uuid REFERENCES auth.users(id),
  amount_eur numeric(10,2) NOT NULL CHECK (amount_eur > 0),
  versed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cagnotte_entries_club ON public.club_cagnotte_entries(club_id);
CREATE INDEX IF NOT EXISTS idx_cagnotte_entries_club_unversed ON public.club_cagnotte_entries(club_id) WHERE NOT versed;

ALTER TABLE public.club_cagnotte_entries ENABLE ROW LEVEL SECURITY;

-- Lecture : le club voit ses propres contributions (pour afficher le solde),
-- l'admin voit tout. Aucune policy INSERT/UPDATE/DELETE pour les rôles
-- authenticated/anon : seule l'Edge Function confirm-order (service_role,
-- qui contourne RLS) ou la RPC verse_club_cagnotte ci-dessous (SECURITY
-- DEFINER) peuvent écrire — même logique que orders.pricing : le montant
-- crédité au club ne doit jamais dépendre d'une valeur envoyée par un
-- client, patient ou club confondu.
DROP POLICY IF EXISTS "cagnotte_entries_club_read" ON public.club_cagnotte_entries;
CREATE POLICY "cagnotte_entries_club_read"
  ON public.club_cagnotte_entries FOR SELECT
  USING (club_id IN (SELECT id FROM public.clubs WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "cagnotte_entries_admin_read" ON public.club_cagnotte_entries;
CREATE POLICY "cagnotte_entries_admin_read"
  ON public.club_cagnotte_entries FOR SELECT
  USING (public.is_admin());

CREATE TABLE IF NOT EXISTS public.club_cagnotte_versements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  amount_eur numeric(10,2) NOT NULL,
  entries_count integer NOT NULL,
  year integer NOT NULL DEFAULT extract(year FROM now()),
  versed_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cagnotte_versements_club ON public.club_cagnotte_versements(club_id);

ALTER TABLE public.club_cagnotte_versements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cagnotte_versements_club_read" ON public.club_cagnotte_versements;
CREATE POLICY "cagnotte_versements_club_read"
  ON public.club_cagnotte_versements FOR SELECT
  USING (club_id IN (SELECT id FROM public.clubs WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "cagnotte_versements_admin_read" ON public.club_cagnotte_versements;
CREATE POLICY "cagnotte_versements_admin_read"
  ON public.club_cagnotte_versements FOR SELECT
  USING (public.is_admin());

-- Versement admin — atomique via UPDATE...RETURNING dans un CTE (une seule
-- instruction SQL) : deux appels concurrents sur le même club ne peuvent
-- pas tous les deux additionner le même solde, le second appel ne trouvera
-- simplement plus aucune ligne `versed=false` à marquer.
CREATE OR REPLACE FUNCTION public.verse_club_cagnotte(p_club_id uuid)
RETURNS TABLE(versed_amount numeric, entries_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_amount numeric;
  v_count integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Accès refusé : réservé aux administrateurs';
  END IF;

  WITH flipped AS (
    UPDATE public.club_cagnotte_entries
    SET versed = true
    WHERE club_id = p_club_id AND versed = false
    RETURNING amount_eur
  )
  SELECT COALESCE(SUM(amount_eur),0), COUNT(*) INTO v_amount, v_count FROM flipped;

  IF v_count > 0 THEN
    INSERT INTO public.club_cagnotte_versements(club_id, amount_eur, entries_count, versed_by)
    VALUES (p_club_id, v_amount, v_count, auth.uid());
  END IF;

  RETURN QUERY SELECT v_amount, v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verse_club_cagnotte(uuid) TO authenticated;

-- ── 3. Messagerie admin ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES auth.users(id),
  target_scope text NOT NULL CHECK (target_scope IN ('all_pharmacies','all_patients','all_clubs','specific')),
  target_user_id uuid REFERENCES auth.users(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_messages_specific_needs_target CHECK (target_scope <> 'specific' OR target_user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_admin_messages_target_user ON public.admin_messages(target_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_messages_created ON public.admin_messages(created_at DESC);

ALTER TABLE public.admin_messages ENABLE ROW LEVEL SECURITY;

-- Seul un admin peut écrire, et uniquement en son propre nom.
DROP POLICY IF EXISTS "admin_messages_admin_insert" ON public.admin_messages;
CREATE POLICY "admin_messages_admin_insert"
  ON public.admin_messages FOR INSERT
  WITH CHECK (public.is_admin() AND sender_id = auth.uid());

-- L'admin relit l'historique complet de ce qu'il a envoyé.
DROP POLICY IF EXISTS "admin_messages_admin_read" ON public.admin_messages;
CREATE POLICY "admin_messages_admin_read"
  ON public.admin_messages FOR SELECT
  USING (public.is_admin());

-- Chaque destinataire ne voit que les messages qui lui sont réellement
-- destinés : ciblage direct (specific), ou diffusion à son rôle réel
-- (jamais un rôle auto-déclaré côté client — `profiles.role` est protégé
-- par le trigger prevent_role_self_escalation posé lors d'un correctif
-- précédent de cette même session).
DROP POLICY IF EXISTS "admin_messages_recipient_read" ON public.admin_messages;
CREATE POLICY "admin_messages_recipient_read"
  ON public.admin_messages FOR SELECT
  USING (
    target_user_id = auth.uid()
    OR (target_scope = 'all_pharmacies' AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'pharmacien'))
    OR (target_scope = 'all_patients'   AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('patient','patient_licencie')))
    OR (target_scope = 'all_clubs'      AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'club'))
  );
