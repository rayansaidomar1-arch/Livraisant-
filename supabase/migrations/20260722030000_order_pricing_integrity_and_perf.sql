-- ============================================================================
-- Correctifs suite à l'audit sécurité/performance du 2026-07-22
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CRITIQUE : `orders_patient_insert` ne vérifiait que patient_id = auth.uid()
--    — rien ne contraignait la colonne `pricing` (jsonb {totalEur, deliveryFeeEur}).
--    Un patient authentifié pouvait appeler directement `sb.from('orders').insert(...)`
--    (via `window.LS_SB.sbInsertOrderFull`, exposé côté client) avec un `pricing`
--    entièrement fabriqué, sans jamais passer par Stripe / `create-payment-intent`.
--    Cette valeur alimente ensuite les stats admin, les factures pharmacie/livreur
--    et l'export CSV — un montant à 0,01€ (ou au contraire gonflé) était acceptable
--    pour la base de données.
--
--    Fix (voir aussi la nouvelle Edge Function `confirm-order`, déployée séparément) :
--    - Les commandes PAYANTES (santé / click-collect / cnc-club) ne peuvent plus être
--      insérées directement par le patient avec un `pricing.totalEur` non nul — cette
--      valeur ne peut désormais être posée que par `confirm-order`, qui vérifie
--      d'abord auprès de Stripe (avec la clé secrète, côté serveur) que le
--      PaymentIntent existe réellement, appartient à cet utilisateur et a le statut
--      'succeeded', puis insère la commande avec service_role (qui contourne RLS)
--      en utilisant le montant réellement débité par Stripe (`pi.amount`), jamais
--      une valeur envoyée par le client.
--    - Les commandes GRATUITES (kind='sportif', inscriptions à un événement club)
--      continuent d'être insérées directement par le patient : `pricing.totalEur`
--      y est toujours NULL, donc non affecté par cette restriction.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "orders_patient_insert" ON orders;
CREATE POLICY "orders_patient_insert"
  ON orders FOR INSERT
  WITH CHECK (
    patient_id = auth.uid()
    AND (pricing IS NULL OR (pricing->>'totalEur') IS NULL)
  );
-- NB : le rôle service_role a `rolbypassrls = true` (vérifié en base) — cette
-- policy ne s'applique donc jamais aux insertions faites par les Edge Functions
-- via la clé service_role (create-order/confirm-order), seulement aux insertions
-- directes faites par un patient authentifié avec la clé anon/publishable.

-- ----------------------------------------------------------------------------
-- 2. ÉLEVÉ : `orders_pharmacy_update` / "orders: pharmacy update" n'ont pas de
--    WITH CHECK (contrairement au verrou déjà en place côté livreur, cf.
--    `prevent_driver_order_tampering` du 2026-07-18) — une pharmacie pouvait donc
--    réécrire `pricing`, `items`, l'identité du patient, etc. sur n'importe quelle
--    commande qui lui est liée, sans restriction de colonnes.
--
--    Vérifié dans le code (js/supabase-client.js `sbUpdateOrderFields`, tous les
--    appels côté pharmacie dans index.html) : les seules colonnes réellement
--    modifiées par une pharmacie sont `status`, `substitution`, `arrival`,
--    `code_validated`. Jamais `pricing`, `items`, ni les champs d'identité patient.
--
--    Fix : même principe que le verrou livreur — reverrouiller les colonnes
--    sensibles à leur valeur `OLD.*` quand l'appelant est la pharmacie propriétaire
--    de la commande (et non le service_role).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_pharmacy_order_tampering()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Ne s'applique que quand l'appel vient de la pharmacie liée à la commande
  -- (et pas du service_role — backoffice/Edge Functions, qui gardent un accès complet).
  IF auth.role() <> 'service_role' AND EXISTS (
    SELECT 1 FROM pharmacies
    WHERE pharmacies.id = OLD.pharmacy_id AND pharmacies.user_id = auth.uid()
  ) THEN
    NEW.patient_id      := OLD.patient_id;
    NEW.pharmacy_id      := OLD.pharmacy_id;
    NEW.patient_name     := OLD.patient_name;
    NEW.patient_address  := OLD.patient_address;
    NEW.patient_pos      := OLD.patient_pos;
    NEW.items            := OLD.items;
    NEW.pricing          := OLD.pricing;
    NEW.payment          := OLD.payment;
    NEW.kind             := OLD.kind;
    NEW.delivery_mode    := OLD.delivery_mode;
    NEW.code             := OLD.code;
    -- driver_id : l'assignation d'un livreur passe uniquement par la policy
    -- `orders_driver_claim` (le livreur lui-même) — la pharmacie ne réassigne pas.
    NEW.driver_id        := OLD.driver_id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.prevent_pharmacy_order_tampering() SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_prevent_pharmacy_order_tampering ON public.orders;
CREATE TRIGGER trg_prevent_pharmacy_order_tampering
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.prevent_pharmacy_order_tampering();

-- ----------------------------------------------------------------------------
-- 3. PERFORMANCE : aucun index sur les colonnes filtrées en permanence par les
--    policies RLS (`orders_patient`, `orders_pharmacy_read`/`update` via jointure
--    `pharmacies.user_id`, `orders_driver_claim` sur `status`) et par les tableaux
--    de bord (tri par date). Sans impact aujourd'hui (0 ligne en base), mais
--    provoquera des scans complets de la table dès les premiers volumes réels.
--    Ajout maintenant, alors que c'est gratuit (CREATE INDEX quasi instantané
--    sur une table vide).
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orders_patient_id  ON public.orders (patient_id);
CREATE INDEX IF NOT EXISTS idx_orders_pharmacy_id ON public.orders (pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON public.orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at  ON public.orders (created_at DESC);
