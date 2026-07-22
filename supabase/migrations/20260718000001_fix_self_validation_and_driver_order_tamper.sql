-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — Correctifs sécurité RLS (2026-07-18, audit complet)
--
-- Constat (vérifié en direct sur la base Supabase de prod, pas seulement
-- dans les fichiers de migration versionnés — certaines policies ont été
-- ajoutées/retirées depuis le Dashboard sans migration associée) :
--
-- 1. drivers  : la policy "drivers_own" (FOR ALL) + "drivers: self update"
--    permettent à un livreur de modifier N'IMPORTE QUELLE colonne de sa
--    propre fiche, y compris `active`. Un admin qui suspend un livreur en
--    passant `active=false` ne le protège donc pas : le livreur peut se
--    réactiver lui-même via un simple update client.
--
-- 2. health_professionals : la policy "pros_own" (FOR ALL, sans WITH CHECK)
--    + "hp_self" permettent à un professionnel de santé de modifier
--    `validated_by_club` / `rejected` sur sa propre fiche — alors que ces
--    colonnes ne devraient être modifiables que par le club (policy
--    pros_club_update / hp_club_validate) ou le backoffice. Un professionnel
--    peut donc s'auto-valider sans jamais passer par un club.
--
-- 3. club_members : la policy "member_self" (FOR ALL) permet à un adhérent
--    de modifier sa propre colonne `validated`, contournant la validation
--    du club (policy club_validates_members / club_sees_members).
--
-- 4. orders : la policy "orders_driver_update" (FOR UPDATE USING
--    (driver_id = auth.uid())) ne restreint aucune colonne. Un livreur ayant
--    pris en charge une commande peut donc réécrire son prix (pricing),
--    son contenu (items), l'adresse/nom du patient, ou même réassigner la
--    commande à un autre livreur — au lieu de se limiter à faire progresser
--    le statut de livraison.
--
-- Ces 4 points suivent tous le même schéma que le correctif déjà appliqué
-- à `profiles.role` (migration 20260716000000) : on ne retire pas les
-- policies existantes (risque de casser des flux légitimes), on verrouille
-- au niveau colonne via un trigger BEFORE UPDATE qui annule silencieusement
-- toute tentative de modification non autorisée, sauf pour le service_role
-- (Edge Functions / backoffice / futur backend Clever Cloud).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. drivers.active — anti auto-réactivation ────────────────────────
CREATE OR REPLACE FUNCTION prevent_driver_self_reactivation()
RETURNS trigger AS $$
BEGIN
  IF NEW.active IS DISTINCT FROM OLD.active AND auth.role() <> 'service_role' THEN
    NEW.active := OLD.active;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_prevent_driver_self_reactivation ON drivers;
CREATE TRIGGER trg_prevent_driver_self_reactivation
  BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION prevent_driver_self_reactivation();

-- ── 2. health_professionals.validated_by_club / rejected — anti auto-validation ──
CREATE OR REPLACE FUNCTION prevent_pro_self_validation()
RETURNS trigger AS $$
BEGIN
  -- Seul un update qui n'émane PAS du professionnel lui-même (club via
  -- pros_club_update/hp_club_validate, ou service_role/backoffice) peut
  -- changer ces deux colonnes. Si c'est le professionnel qui modifie sa
  -- propre fiche (auth.uid() = user_id), on revient à l'ancienne valeur.
  IF (NEW.validated_by_club IS DISTINCT FROM OLD.validated_by_club
      OR NEW.rejected IS DISTINCT FROM OLD.rejected)
     AND auth.role() <> 'service_role'
     AND auth.uid() = OLD.user_id THEN
    NEW.validated_by_club := OLD.validated_by_club;
    NEW.rejected := OLD.rejected;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_prevent_pro_self_validation ON health_professionals;
CREATE TRIGGER trg_prevent_pro_self_validation
  BEFORE UPDATE ON health_professionals
  FOR EACH ROW EXECUTE FUNCTION prevent_pro_self_validation();

-- ── 3. club_members.validated — anti auto-validation adhérent ─────────
CREATE OR REPLACE FUNCTION prevent_member_self_validation()
RETURNS trigger AS $$
BEGIN
  IF NEW.validated IS DISTINCT FROM OLD.validated
     AND auth.role() <> 'service_role'
     AND auth.uid() = OLD.user_id THEN
    NEW.validated := OLD.validated;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_prevent_member_self_validation ON club_members;
CREATE TRIGGER trg_prevent_member_self_validation
  BEFORE UPDATE ON club_members
  FOR EACH ROW EXECUTE FUNCTION prevent_member_self_validation();

-- ── 4. orders — un livreur ne peut faire progresser que le statut ─────
CREATE OR REPLACE FUNCTION prevent_driver_order_tampering()
RETURNS trigger AS $$
BEGIN
  -- Ne s'applique que quand l'appel vient du livreur assigné lui-même
  -- (auth.uid() = OLD.driver_id) et pas du service_role (backoffice/API).
  -- La pharmacie (orders_pharmacy_update) et le backend continuent d'avoir
  -- un accès complet : cette fonction ne verrouille QUE le chemin livreur.
  IF auth.role() <> 'service_role' AND OLD.driver_id IS NOT NULL AND auth.uid() = OLD.driver_id THEN
    NEW.patient_id       := OLD.patient_id;
    NEW.pharmacy_id       := OLD.pharmacy_id;
    NEW.patient_name      := OLD.patient_name;
    NEW.patient_address   := OLD.patient_address;
    NEW.patient_pos       := OLD.patient_pos;
    NEW.items             := OLD.items;
    NEW.pricing           := OLD.pricing;
    NEW.payment           := OLD.payment;
    NEW.kind              := OLD.kind;
    NEW.delivery_mode     := OLD.delivery_mode;
    NEW.substitution      := OLD.substitution;
    NEW.code              := OLD.code;
    -- driver_id : un livreur peut abandonner une commande (repasser à NULL)
    -- mais jamais la réassigner à quelqu'un d'autre.
    IF NEW.driver_id IS DISTINCT FROM OLD.driver_id AND NEW.driver_id IS NOT NULL THEN
      NEW.driver_id := OLD.driver_id;
    END IF;
    -- status : seules les transitions de livraison sont autorisées côté livreur.
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (NEW.status = ANY (ARRAY['en_livraison','livree'])) THEN
      NEW.status := OLD.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_prevent_driver_order_tampering ON orders;
CREATE TRIGGER trg_prevent_driver_order_tampering
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION prevent_driver_order_tampering();
