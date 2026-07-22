-- ============================================================================
-- Correctif — récursion infinie RLS entre `orders` et `drivers` (2026-07-23)
-- ============================================================================
--
-- BUG DÉCOUVERT (pré-existant, indépendant des correctifs du 2026-07-22) :
--   Toute tentative de mise à jour d'une commande (`orders`) par une pharmacie
--   authentifiée échouait systématiquement avec :
--     ERROR: 42P17: infinite recursion detected in policy for relation "orders"
--   ...y compris pour une UPDATE ne touchant QUE la colonne `status` (aucun lien
--   avec les correctifs pricing/trigger anti-tampering du 2026-07-22). Cela
--   cassait donc en production le fonctionnement normal du dashboard pharmacie
--   (validation/traitement des commandes), au-delà de toute question de sécurité.
--
-- CAUSE RACINE — dépendance circulaire entre deux policies RLS :
--   - `orders_driver_claim` (policy UPDATE sur `orders`) contient :
--       EXISTS (SELECT 1 FROM drivers WHERE drivers.user_id = auth.uid() AND drivers.active = true)
--     → lire `drivers` déclenche l'évaluation des policies RLS de `drivers`.
--   - `drivers_pharma_read` (policy SELECT sur `drivers`) contenait :
--       EXISTS (SELECT 1 FROM orders o JOIN pharmacies ph ON ph.id = o.pharmacy_id
--               WHERE o.driver_id = drivers.user_id AND ph.user_id = auth.uid())
--     → qui relit `orders`, donc re-déclenche les policies de `orders`, etc.
--   Résultat : `orders` → `drivers` → `orders` → `drivers` → ... boucle détectée
--   par Postgres et rejetée avec l'erreur 42P17, quelle que soit la commande
--   réellement en cours (UPDATE simple ou non).
--
-- Confirmé en reproduisant directement en SQL (rôle `authenticated` + JWT claims
-- simulés pour l'utilisateur pharmacie) : désactiver temporairement la policy
-- `drivers_pharma_read` seule (sans toucher à quoi que ce soit d'autre) fait
-- disparaître l'erreur — isolant précisément la policy fautive.
--
-- FIX — pattern standard Postgres/Supabase pour casser un cycle RLS : déplacer
-- la vérification cross-table dans une fonction `SECURITY DEFINER` (déjà utilisé
-- ailleurs dans ce projet pour `is_admin()`). Le rôle propriétaire (`postgres`)
-- a l'attribut `rolbypassrls = true` (vérifié en base) : les requêtes internes à
-- la fonction contournent donc complètement RLS sur `orders`/`pharmacies`, ce qui
-- casse le cycle sans changer la portée d'accès accordée à la pharmacie (elle ne
-- peut toujours voir que les livreurs actuellement assignés à UNE de ses
-- commandes — la fonction encode exactement la même condition qu'avant).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pharmacy_owns_driver_active_order(p_driver_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM orders o
    JOIN pharmacies ph ON ph.id = o.pharmacy_id
    WHERE o.driver_id = p_driver_user_id AND ph.user_id = auth.uid()
  );
$$;

DROP POLICY IF EXISTS drivers_pharma_read ON drivers;
CREATE POLICY drivers_pharma_read ON drivers FOR SELECT
  USING (public.pharmacy_owns_driver_active_order(drivers.user_id));

-- ----------------------------------------------------------------------------
-- Vérification post-fix (effectuée en prod le 2026-07-23, via simulation JWT
-- directe en SQL, rôle `authenticated`) :
--   - UPDATE `orders.status` par la pharmacie propriétaire de la commande :
--     réussit désormais (plus de 42P17).
--   - Tentative de tamper simultanée (pricing/items/patient_name falsifiés en
--     même temps que status) avec `trg_prevent_pharmacy_order_tampering`
--     réactivé (migration 20260722030000) : `status` est bien appliqué, mais
--     `pricing`/`items`/`patient_name` reviennent silencieusement à leur valeur
--     `OLD` — confirmant que ce correctif de récursion n'a pas réintroduit la
--     faille visée par le trigger anti-tampering.
-- ----------------------------------------------------------------------------
