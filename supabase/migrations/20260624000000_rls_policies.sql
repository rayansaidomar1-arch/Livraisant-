-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — Supabase RLS (Row Level Security) — Production policies
-- Migration: 20260624000000_rls_policies
-- Requires: Supabase Auth enabled, profiles table with role column
-- ═══════════════════════════════════════════════════════════════════════

-- ── Enable RLS on all tables ──────────────────────────────────────────
ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE clubs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments     ENABLE ROW LEVEL SECURITY;

-- ── Helper: get current user role ────────────────────────────────────
CREATE OR REPLACE FUNCTION get_my_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM profiles WHERE id = auth.uid()
$$;

-- ──────────────────────────────────────────────────────────────────────
-- TABLE: profiles
-- ──────────────────────────────────────────────────────────────────────
-- Users can read and update only their own profile
CREATE POLICY "profiles_select_own"    ON profiles FOR SELECT USING (id = auth.uid());
CREATE POLICY "profiles_insert_own"    ON profiles FOR INSERT WITH CHECK (id = auth.uid());
CREATE POLICY "profiles_update_own"    ON profiles FOR UPDATE USING (id = auth.uid());
-- Admin can read all profiles
CREATE POLICY "profiles_admin_select"  ON profiles FOR SELECT USING (get_my_role() = 'admin');

-- ──────────────────────────────────────────────────────────────────────
-- TABLE: pharmacies
-- ──────────────────────────────────────────────────────────────────────
-- Pharmacy owner reads/updates their own record
CREATE POLICY "pharma_own"         ON pharmacies FOR ALL USING (user_id = auth.uid());
-- Patients can read pharmacy info (name, address) to display on map
CREATE POLICY "pharma_public_read" ON pharmacies FOR SELECT USING (true);

-- ──────────────────────────────────────────────────────────────────────
-- TABLE: orders
-- ──────────────────────────────────────────────────────────────────────
-- Patient sees own orders
CREATE POLICY "orders_patient" ON orders FOR SELECT USING (patient_id = auth.uid());
-- Patient creates orders
CREATE POLICY "orders_patient_insert" ON orders FOR INSERT WITH CHECK (patient_id = auth.uid());
-- Pharmacy sees orders destined to their pharmacy
CREATE POLICY "orders_pharmacy" ON orders FOR SELECT USING (
  pharmacy_id IN (SELECT id FROM pharmacies WHERE user_id = auth.uid())
);
-- Pharmacy updates order status
CREATE POLICY "orders_pharmacy_update" ON orders FOR UPDATE USING (
  pharmacy_id IN (SELECT id FROM pharmacies WHERE user_id = auth.uid())
);
-- Driver sees orders assigned to them
CREATE POLICY "orders_driver" ON orders FOR SELECT USING (
  driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid())
);
-- Driver updates delivery status
CREATE POLICY "orders_driver_update" ON orders FOR UPDATE USING (
  driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid())
);
-- Admin sees all
CREATE POLICY "orders_admin" ON orders FOR ALL USING (get_my_role() = 'admin');

-- ──────────────────────────────────────────────────────────────────────
-- TABLE: drivers
-- ──────────────────────────────────────────────────────────────────────
CREATE POLICY "drivers_own"    ON drivers FOR ALL USING (user_id = auth.uid());
CREATE POLICY "drivers_admin"  ON drivers FOR ALL USING (get_my_role() = 'admin');
-- Pharmacies can read driver info (for delivery assignment)
CREATE POLICY "drivers_pharma_read" ON drivers FOR SELECT USING (get_my_role() = 'pharmacien');

-- ──────────────────────────────────────────────────────────────────────
-- TABLE: settlements
-- ──────────────────────────────────────────────────────────────────────
CREATE POLICY "settlements_pharmacy" ON settlements FOR SELECT USING (
  pharmacy_id IN (SELECT id FROM pharmacies WHERE user_id = auth.uid())
);
CREATE POLICY "settlements_admin" ON settlements FOR ALL USING (get_my_role() = 'admin');

-- ──────────────────────────────────────────────────────────────────────
-- TABLE: clubs
-- ──────────────────────────────────────────────────────────────────────
CREATE POLICY "clubs_own"          ON clubs FOR ALL USING (user_id = auth.uid());
CREATE POLICY "clubs_public_read"  ON clubs FOR SELECT USING (true);
CREATE POLICY "clubs_admin"        ON clubs FOR ALL USING (get_my_role() = 'admin');

-- ──────────────────────────────────────────────────────────────────────
-- TABLE: club_members
-- ──────────────────────────────────────────────────────────────────────
CREATE POLICY "club_members_own"    ON club_members FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "club_members_club"   ON club_members FOR SELECT USING (
  club_id IN (SELECT id FROM clubs WHERE user_id = auth.uid())
);
CREATE POLICY "club_members_insert" ON club_members FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "club_members_admin"  ON club_members FOR ALL USING (get_my_role() = 'admin');

-- ──────────────────────────────────────────────────────────────────────
-- TABLE: health_professionals
-- ──────────────────────────────────────────────────────────────────────
CREATE POLICY "pros_own"       ON health_professionals FOR ALL USING (user_id = auth.uid());
CREATE POLICY "pros_club"      ON health_professionals FOR SELECT USING (
  club_id IN (SELECT id FROM clubs WHERE user_id = auth.uid())
);
CREATE POLICY "pros_club_update" ON health_professionals FOR UPDATE USING (
  club_id IN (SELECT id FROM clubs WHERE user_id = auth.uid())
);
CREATE POLICY "pros_admin"     ON health_professionals FOR ALL USING (get_my_role() = 'admin');

-- ──────────────────────────────────────────────────────────────────────
-- TABLE: appointments
-- ──────────────────────────────────────────────────────────────────────
CREATE POLICY "appt_patient"  ON appointments FOR SELECT USING (patient_id = auth.uid());
CREATE POLICY "appt_patient_insert" ON appointments FOR INSERT WITH CHECK (patient_id = auth.uid());
CREATE POLICY "appt_pro"      ON appointments FOR SELECT USING (
  pro_id IN (SELECT id FROM health_professionals WHERE user_id = auth.uid())
);
CREATE POLICY "appt_pro_update" ON appointments FOR UPDATE USING (
  pro_id IN (SELECT id FROM health_professionals WHERE user_id = auth.uid())
);
CREATE POLICY "appt_admin"    ON appointments FOR ALL USING (get_my_role() = 'admin');

-- ── Production security hardening ─────────────────────────────────────
-- Prevent users from escalating their own role
CREATE OR REPLACE FUNCTION prevent_role_escalation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role AND get_my_role() != 'admin' THEN
    RAISE EXCEPTION 'role escalation not allowed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_role_escalation ON profiles;
CREATE TRIGGER trg_prevent_role_escalation
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION prevent_role_escalation();
