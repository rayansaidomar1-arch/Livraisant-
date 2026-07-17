-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — Correctifs suite audit de sécurité complet (2026-07-16)
-- 1. profiles : rien n'empêchait un utilisateur authentifié de s'octroyer
--    le rôle admin lui-même (ex. via la console :
--    supabase.from('profiles').update({role:'admin'}).eq('id', monId)),
--    ce qui lui donnait ensuite accès à toutes les policies "admin bypass"
--    posées dans 20260711000000. On verrouille : chacun peut lire/modifier
--    SON PROPRE profil, mais un trigger annule silencieusement tout
--    changement de la colonne `role` tant que la requête ne vient pas du
--    service_role (Edge Function admin / backoffice), jamais du navigateur.
-- 2. drivers : une pharmacie pouvait lire la fiche de TOUS les livreurs
--    actifs (IBAN compris), pas seulement ceux ayant réellement pris en
--    charge une de ses commandes. On restreint à la vraie relation via
--    orders.driver_id / orders.pharmacy_id (colonnes déjà présentes après
--    20260711000000_admin_bypass_and_driver_hardening.sql).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. profiles — anti auto-escalation de rôle ────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_own_read" ON profiles;
CREATE POLICY "profiles_own_read"
  ON profiles FOR SELECT
  USING (id = auth.uid());

DROP POLICY IF EXISTS "profiles_own_update" ON profiles;
CREATE POLICY "profiles_own_update"
  ON profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Empêche toute modification de `role` par un appel client (anon/authenticated),
-- même via un simple UPDATE REST direct depuis la console. auth.role() ne vaut
-- 'service_role' que pour les appels utilisant la clé service_role (Edge
-- Functions admin) — jamais pour un utilisateur connecté depuis le navigateur.
CREATE OR REPLACE FUNCTION prevent_role_self_escalation()
RETURNS trigger AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role AND auth.role() <> 'service_role' THEN
    NEW.role := OLD.role;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_prevent_role_self_escalation ON profiles;
CREATE TRIGGER trg_prevent_role_self_escalation
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION prevent_role_self_escalation();

-- Note : ceci protège les UPDATE. Si un trigger "handle_new_user" (créé via le
-- Dashboard, non versionné dans ce dépôt) copie tel quel un rôle fourni par le
-- client à l'INSCRIPTION (user_metadata.role) dans profiles.role à la création,
-- il faut aussi le corriger pour forcer 'patient' par défaut et ignorer toute
-- valeur "admin"/"pharmacie" etc. envoyée par le client — impossible à vérifier
-- depuis ce dépôt (le trigger n'est pas dans nos fichiers), à vérifier dans
-- Dashboard → Database → Functions/Triggers.

-- ── 2. drivers — lecture restreinte à la vraie relation pharmacie↔livreur ──
DROP POLICY IF EXISTS "drivers_pharma_read" ON drivers;
CREATE POLICY "drivers_pharma_read"
  ON drivers FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM orders o
      JOIN pharmacies ph ON ph.id = o.pharmacy_id
      WHERE o.driver_id = drivers.user_id
        AND ph.user_id = auth.uid()
    )
  );
