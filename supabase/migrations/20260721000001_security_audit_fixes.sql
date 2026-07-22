-- ============================================================================
-- Correctifs suite à l'audit de sécurité du 2026-07-21
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CRITIQUE : les vues publiques `pharmacies_public`, `clubs_public` et
--    `orders_driver_available` s'exécutaient avec les droits du propriétaire
--    (postgres) au lieu de ceux de l'appelant, ce qui contournait TOUTES les
--    policies RLS des tables sous-jacentes. Combiné aux droits par défaut
--    (INSERT/UPDATE/DELETE accordés à anon/authenticated sur les vues),
--    n'importe qui pouvait, sans authentification, modifier ou supprimer
--    n'importe quelle commande/pharmacie/club via PostgREST.
--
--    Fix : security_invoker = true (la vue respecte désormais la RLS de
--    l'appelant, plus celle du propriétaire) + retrait des droits d'écriture,
--    ces vues étant strictement des vitrines de lecture pour le grand public.
-- ----------------------------------------------------------------------------
ALTER VIEW public.pharmacies_public        SET (security_invoker = true);
ALTER VIEW public.clubs_public             SET (security_invoker = true);
ALTER VIEW public.orders_driver_available  SET (security_invoker = true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.pharmacies_public FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.clubs_public FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.orders_driver_available FROM anon, authenticated;

GRANT SELECT ON public.pharmacies_public       TO anon, authenticated;
GRANT SELECT ON public.clubs_public            TO anon, authenticated;
GRANT SELECT ON public.orders_driver_available TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. ÉLEVÉ : `orders_patient_insert` / `appt_patient_insert` ne vérifient que
--    patient_id = auth.uid() au moment de l'INSERT. Rien n'empêchait un
--    patient d'insérer directement une commande déjà status='livree' avec un
--    driver_id arbitraire (fraude sur les règlements d'un livreur/pharmacie
--    ciblé) ou un rendez-vous déjà 'confirmed'.
--
--    Fix : verrouiller status/driver_id/code_validated à leur valeur initiale
--    sûre pour tout INSERT qui ne vient pas du service_role (backend/API).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_order_insert_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    NEW.status         := 'nouvelle';
    NEW.driver_id       := NULL;
    NEW.code_validated  := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_order_insert_fields ON public.orders;
CREATE TRIGGER trg_lock_order_insert_fields
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.lock_order_insert_fields();

CREATE OR REPLACE FUNCTION public.lock_appointment_insert_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    NEW.status := 'pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_appointment_insert_fields ON public.appointments;
CREATE TRIGGER trg_lock_appointment_insert_fields
  BEFORE INSERT ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.lock_appointment_insert_fields();

-- ----------------------------------------------------------------------------
-- 3. ÉLEVÉ : la policy `pharma_own` (ALL, user_id = auth.uid()) permet à un
--    pharmacien de modifier n'importe quelle colonne de sa propre fiche, y
--    compris `plan` / `plan_name` / `period` — donc de s'auto-attribuer un
--    abonnement payant sans passer par Stripe.
--
--    Fix : verrouiller ces 3 colonnes à leur valeur précédente sauf appel
--    service_role (le futur backend, une fois le paiement Stripe confirmé,
--    sera le seul à pouvoir les modifier).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lock_pharmacy_plan_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    NEW.plan      := OLD.plan;
    NEW.plan_name := OLD.plan_name;
    NEW.period    := OLD.period;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_pharmacy_plan_fields ON public.pharmacies;
CREATE TRIGGER trg_lock_pharmacy_plan_fields
  BEFORE UPDATE ON public.pharmacies
  FOR EACH ROW EXECUTE FUNCTION public.lock_pharmacy_plan_fields();

-- ----------------------------------------------------------------------------
-- 4. Durcissement (LOW) : les fonctions SECURITY DEFINER existantes n'avaient
--    pas de search_path explicite (risque théorique de détournement de schéma
--    si un rôle malveillant pouvait créer des objets dans un schéma placé
--    avant `public` dans le search_path de l'appelant). Alignement sur le
--    même correctif que les nouvelles fonctions ci-dessus.
-- ----------------------------------------------------------------------------
ALTER FUNCTION public.prevent_driver_order_tampering()   SET search_path = public, pg_temp;
ALTER FUNCTION public.prevent_driver_self_reactivation() SET search_path = public, pg_temp;
ALTER FUNCTION public.prevent_member_self_validation()   SET search_path = public, pg_temp;
ALTER FUNCTION public.prevent_pro_self_validation()      SET search_path = public, pg_temp;
ALTER FUNCTION public.prevent_role_escalation()          SET search_path = public, pg_temp;
ALTER FUNCTION public.prevent_role_self_escalation()     SET search_path = public, pg_temp;
