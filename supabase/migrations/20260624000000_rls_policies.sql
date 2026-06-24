-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — Supabase RLS (Row Level Security) — Production policies
-- Migration: 20260624000000_rls_policies
-- Applied: 2026-06-24 via Supabase SQL Editor
-- Tables: pharmacies, orders, drivers, clubs, club_members,
--         health_professionals, appointments
-- ═══════════════════════════════════════════════════════════════════════

-- ── Drop existing policies (idempotent) ───────────────────────────────
DROP POLICY IF EXISTS "pharma_own"               ON pharmacies;
DROP POLICY IF EXISTS "pharma_public_read"        ON pharmacies;

DROP POLICY IF EXISTS "orders_patient"            ON orders;
DROP POLICY IF EXISTS "orders_patient_insert"     ON orders;
DROP POLICY IF EXISTS "orders_pharmacy_read"      ON orders;
DROP POLICY IF EXISTS "orders_pharmacy_update"    ON orders;
DROP POLICY IF EXISTS "orders_driver_read"        ON orders;
DROP POLICY IF EXISTS "orders_pharmacy"           ON orders;
DROP POLICY IF EXISTS "orders_driver"             ON orders;
DROP POLICY IF EXISTS "orders_driver_update"      ON orders;
DROP POLICY IF EXISTS "orders_admin"              ON orders;

DROP POLICY IF EXISTS "drivers_own"               ON drivers;
DROP POLICY IF EXISTS "drivers_pharma_read"       ON drivers;
DROP POLICY IF EXISTS "drivers_admin"             ON drivers;

DROP POLICY IF EXISTS "clubs_own"                 ON clubs;
DROP POLICY IF EXISTS "clubs_public_read"         ON clubs;
DROP POLICY IF EXISTS "clubs_admin"               ON clubs;

DROP POLICY IF EXISTS "club_members_own"          ON club_members;
DROP POLICY IF EXISTS "club_members_insert"       ON club_members;
DROP POLICY IF EXISTS "club_members_club"         ON club_members;
DROP POLICY IF EXISTS "club_members_club_read"    ON club_members;
DROP POLICY IF EXISTS "club_members_club_update"  ON club_members;
DROP POLICY IF EXISTS "club_members_admin"        ON club_members;

DROP POLICY IF EXISTS "pros_own"                  ON health_professionals;
DROP POLICY IF EXISTS "pros_club"                 ON health_professionals;
DROP POLICY IF EXISTS "pros_club_read"            ON health_professionals;
DROP POLICY IF EXISTS "pros_club_update"          ON health_professionals;
DROP POLICY IF EXISTS "pros_admin"                ON health_professionals;

DROP POLICY IF EXISTS "appt_patient"              ON appointments;
DROP POLICY IF EXISTS "appt_patient_read"         ON appointments;
DROP POLICY IF EXISTS "appt_patient_insert"       ON appointments;
DROP POLICY IF EXISTS "appt_pro"                  ON appointments;
DROP POLICY IF EXISTS "appt_pro_read"             ON appointments;
DROP POLICY IF EXISTS "appt_pro_update"           ON appointments;
DROP POLICY IF EXISTS "appt_admin"                ON appointments;

-- ── Enable RLS ────────────────────────────────────────────────────────
ALTER TABLE pharmacies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE clubs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_members         ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments         ENABLE ROW LEVEL SECURITY;

-- ── pharmacies ────────────────────────────────────────────────────────
CREATE POLICY "pharma_own"
  ON pharmacies FOR ALL USING (user_id = auth.uid());
CREATE POLICY "pharma_public_read"
  ON pharmacies FOR SELECT USING (true);

-- ── orders ────────────────────────────────────────────────────────────
CREATE POLICY "orders_patient"
  ON orders FOR SELECT USING (patient_id = auth.uid());
CREATE POLICY "orders_patient_insert"
  ON orders FOR INSERT WITH CHECK (patient_id = auth.uid());
CREATE POLICY "orders_pharmacy_read"
  ON orders FOR SELECT USING (
    pharmacy_id IN (SELECT id FROM pharmacies WHERE user_id = auth.uid())
  );
CREATE POLICY "orders_pharmacy_update"
  ON orders FOR UPDATE USING (
    pharmacy_id IN (SELECT id FROM pharmacies WHERE user_id = auth.uid())
  );
-- Livreurs : voient les commandes disponibles (pas de driver_id dans orders)
CREATE POLICY "orders_driver_read"
  ON orders FOR SELECT USING (
    status IN ('validee','prete','en_livraison')
    AND EXISTS (SELECT 1 FROM drivers WHERE user_id = auth.uid() AND active = true)
  );

-- ── drivers ───────────────────────────────────────────────────────────
CREATE POLICY "drivers_own"
  ON drivers FOR ALL USING (user_id = auth.uid());
CREATE POLICY "drivers_pharma_read"
  ON drivers FOR SELECT USING (
    EXISTS (SELECT 1 FROM pharmacies WHERE user_id = auth.uid())
  );

-- ── clubs ─────────────────────────────────────────────────────────────
CREATE POLICY "clubs_own"
  ON clubs FOR ALL USING (user_id = auth.uid());
CREATE POLICY "clubs_public_read"
  ON clubs FOR SELECT USING (true);

-- ── club_members ──────────────────────────────────────────────────────
CREATE POLICY "club_members_own"
  ON club_members FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "club_members_insert"
  ON club_members FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "club_members_club_read"
  ON club_members FOR SELECT USING (
    club_id IN (SELECT id FROM clubs WHERE user_id = auth.uid())
  );
CREATE POLICY "club_members_club_update"
  ON club_members FOR UPDATE USING (
    club_id IN (SELECT id FROM clubs WHERE user_id = auth.uid())
  );

-- ── health_professionals ──────────────────────────────────────────────
CREATE POLICY "pros_own"
  ON health_professionals FOR ALL USING (user_id = auth.uid());
CREATE POLICY "pros_club_read"
  ON health_professionals FOR SELECT USING (
    club_id IN (SELECT id FROM clubs WHERE user_id = auth.uid())
  );
CREATE POLICY "pros_club_update"
  ON health_professionals FOR UPDATE USING (
    club_id IN (SELECT id FROM clubs WHERE user_id = auth.uid())
  );

-- ── appointments ──────────────────────────────────────────────────────
CREATE POLICY "appt_patient_read"
  ON appointments FOR SELECT USING (patient_id = auth.uid());
CREATE POLICY "appt_patient_insert"
  ON appointments FOR INSERT WITH CHECK (patient_id = auth.uid());
CREATE POLICY "appt_pro_read"
  ON appointments FOR SELECT USING (
    pro_id IN (SELECT id FROM health_professionals WHERE user_id = auth.uid())
  );
CREATE POLICY "appt_pro_update"
  ON appointments FOR UPDATE USING (
    pro_id IN (SELECT id FROM health_professionals WHERE user_id = auth.uid())
  );
