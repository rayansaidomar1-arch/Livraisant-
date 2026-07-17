-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — Correctifs suite audit de sécurité (2026-07-10/11)
-- 1. Policies "admin bypass" — le dashboard admin (index.html, role='admin')
--    a besoin de compter pharmacies/clubs/orders/health_professionals, mais
--    aucune policy ne le permettait (seule la policy publique "USING(true)"
--    qu'on vient de supprimer le permettait par accident). On rétablit
--    l'accès, mais UNIQUEMENT pour un utilisateur dont profiles.role='admin'
--    — jamais pour le public.
-- 2. Durcissement orders/livreurs : un livreur ne doit voir le détail complet
--    (médicaments, adresse) que des commandes qu'il a réellement prises en
--    charge, pas de toutes les commandes disponibles. Ajout d'une colonne
--    driver_id (absente jusqu'ici) pour matérialiser la prise en charge, et
--    des policies de claim/update correspondantes.
--    Sans impact sur la prod actuelle : le flux commandes/livreurs de
--    index.html n'est pas encore branché sur Supabase (encore en
--    localStorage) — donc rien à casser, tout est prêt pour la suite.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Admin bypass (lecture seule) ───────────────────────────────────
DROP POLICY IF EXISTS "pharma_admin_read" ON pharmacies;
CREATE POLICY "pharma_admin_read"
  ON pharmacies FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

DROP POLICY IF EXISTS "clubs_admin_read" ON clubs;
CREATE POLICY "clubs_admin_read"
  ON clubs FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

DROP POLICY IF EXISTS "orders_admin_read" ON orders;
CREATE POLICY "orders_admin_read"
  ON orders FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

DROP POLICY IF EXISTS "pros_admin_read" ON health_professionals;
CREATE POLICY "pros_admin_read"
  ON health_professionals FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- ── 2. Durcissement orders / livreurs ─────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_id uuid REFERENCES auth.users(id);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);

-- Remplace l'ancienne policy qui exposait TOUTES les colonnes (dont les
-- médicaments et l'adresse) de TOUTES les commandes disponibles à TOUT
-- livreur actif, même avant qu'il ne prenne la commande en charge.
DROP POLICY IF EXISTS "orders_driver_read" ON orders;
CREATE POLICY "orders_driver_read_claimed"
  ON orders FOR SELECT
  USING (driver_id = auth.uid());

-- Un livreur actif peut "prendre en charge" (claim) une commande non
-- assignée et disponible — ceci s'exécute via un simple UPDATE
-- SET driver_id = auth.uid() WHERE id = ... (la condition WHERE driver_id
-- IS NULL évite qu'un deuxième livreur ne vole une commande déjà prise).
CREATE POLICY "orders_driver_claim"
  ON orders FOR UPDATE
  USING (
    driver_id IS NULL
    AND status IN ('validee','prete')
    AND EXISTS (SELECT 1 FROM drivers WHERE user_id = auth.uid() AND active = true)
  )
  WITH CHECK (driver_id = auth.uid());

-- Un livreur peut mettre à jour le statut (en_livraison, livree, ...) des
-- commandes qu'il a déjà prises en charge.
CREATE POLICY "orders_driver_update"
  ON orders FOR UPDATE
  USING (driver_id = auth.uid());

-- Vue "commandes disponibles" — permet à un livreur de parcourir la liste
-- des commandes à prendre SANS voir le détail santé (médicaments, adresse)
-- avant de les avoir explicitement prises en charge.
CREATE OR REPLACE VIEW orders_driver_available AS
  SELECT id, pharmacy_id, status, created_at
  FROM orders
  WHERE driver_id IS NULL AND status IN ('validee','prete');

GRANT SELECT ON orders_driver_available TO authenticated;

-- ── Note ──────────────────────────────────────────────────────────────
-- Ce fichier redessine la mécanique de prise en charge des commandes par
-- les livreurs (ajout driver_id + claim). Comme ce flux n'est pas encore
-- utilisé en prod (index.html ne fait encore aucun appel sbGetOrders /
-- sbUpdateOrderStatus / sbInsertOrder — tout tourne en localStorage), ce
-- script est sans risque à exécuter maintenant : il prépare seulement le
-- terrain pour quand ce flux sera branché sur Supabase (ou sur le futur
-- backend Clever Cloud).
