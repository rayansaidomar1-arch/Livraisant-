-- ============================================================================
-- Livraisanté — Créneaux ouverts proposés par un professionnel de santé (2026-08-05)
--
-- Constat : addProSlot() (index.html) permet à un professionnel de santé de
-- proposer un créneau ouvert (insert `appointments` avec pro_id, club_id,
-- scheduled_at, motif, status='pending' — volontairement SANS patient_id).
-- Aucune policy RLS INSERT ne couvre ce cas : `appt_patient_insert` exige
-- patient_id = auth.uid() (donc échoue puisque patient_id est NULL), et il
-- n'existe aucune policy d'insertion côté pro. Le insert échoue silencieusement
-- en RLS à chaque appel en production.
--
-- Même en corrigeant l'insert, aucune policy ne permettait à un patient de
-- « réclamer » un créneau ouvert (UPDATE patient_id sur une ligne où il est
-- NULL) : il n'existe pas de policy `appt_patient_claim`.
--
-- Fix :
--   1. `appt_pro_insert` — un professionnel de santé peut créer un créneau
--      pour lui-même, uniquement s'il est encore libre (patient_id IS NULL).
--   2. `appt_open_read` — un utilisateur authentifié peut voir les créneaux
--      libres et proposés (patient_id IS NULL, status='pending'), pour
--      pouvoir les parcourir avant de les réclamer.
--   3. `appt_patient_claim` — un utilisateur authentifié peut réclamer un
--      créneau encore libre en s'assignant comme patient_id.
--   4. Comme pour les correctifs de 20260718000001 (driver/orders, pro
--      self-validation, etc.), une policy WITH CHECK seule ne restreint pas
--      QUELLES colonnes changent : sans garde supplémentaire, un patient qui
--      réclame un créneau pourrait aussi en réécrire la date, le motif, le
--      pro ou le statut dans le même appel. On verrouille donc ces colonnes
--      via un trigger BEFORE UPDATE, sur le même modèle que
--      prevent_driver_order_tampering().
-- ============================================================================

-- ── 1. Un pro peut proposer un créneau libre pour lui-même ────────────────
DROP POLICY IF EXISTS "appt_pro_insert" ON public.appointments;
CREATE POLICY "appt_pro_insert"
  ON public.appointments FOR INSERT
  WITH CHECK (
    patient_id IS NULL
    AND pro_id IN (SELECT id FROM health_professionals WHERE user_id = auth.uid())
  );

-- ── 2. Un utilisateur connecté peut parcourir les créneaux encore libres ──
DROP POLICY IF EXISTS "appt_open_read" ON public.appointments;
CREATE POLICY "appt_open_read"
  ON public.appointments FOR SELECT
  USING (
    patient_id IS NULL
    AND status = 'pending'
    AND auth.uid() IS NOT NULL
  );

-- ── 3. Un utilisateur connecté peut réclamer un créneau encore libre ──────
DROP POLICY IF EXISTS "appt_patient_claim" ON public.appointments;
CREATE POLICY "appt_patient_claim"
  ON public.appointments FOR UPDATE
  USING (patient_id IS NULL AND status = 'pending')
  WITH CHECK (patient_id = auth.uid());

-- ── 4. Verrou colonne : réclamer un créneau ne doit changer QUE patient_id ─
CREATE OR REPLACE FUNCTION public.prevent_appointment_claim_tampering()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role'
     AND OLD.patient_id IS NULL
     AND NEW.patient_id IS NOT NULL THEN
    NEW.pro_id       := OLD.pro_id;
    NEW.club_id      := OLD.club_id;
    NEW.scheduled_at := OLD.scheduled_at;
    NEW.motif        := OLD.motif;
    NEW.status       := OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_appointment_claim_tampering ON public.appointments;
CREATE TRIGGER trg_prevent_appointment_claim_tampering
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.prevent_appointment_claim_tampering();
