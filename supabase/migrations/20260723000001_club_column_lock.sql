-- ============================================================================
-- Correctif — verrou de colonnes manquant sur les UPDATE club (2026-07-23)
-- ============================================================================
-- Audit sécurité 2026-07-22, item Moyen : « Policies club/pro sans verrou de
-- colonnes (un club pourrait modifier le RPPS d'un membre qu'il gère) ».
--
-- Vérifié en base (pg_policies) : les policies UPDATE qui laissent un club
-- modifier une ligne `health_professionals`/`club_members` de ses membres
-- (`pros_club_update`, `hp_club_validate`, `club_members_club_update`,
-- `club_validates_members`) n'ont **aucun WITH CHECK** — elles ne contraignent
-- que quelle ligne est visible, pas quelles colonnes changent. Contrairement
-- aux triggers déjà en place pour livreur/pharmacie sur `orders`
-- (`prevent_driver_order_tampering`, `prevent_pharmacy_order_tampering`), rien
-- n'empêchait un club de réécrire, via un simple appel UPDATE authentifié :
--   - `health_professionals.rpps` (numéro RPPS du professionnel de santé)
--   - `health_professionals.profession`, `.user_id`, `.club_id`
--   - `club_members.numero_licence`, `.user_id`, `.club_id`
-- Seule action réellement destinée au club : valider/rejeter un membre
-- (`validated_by_club`/`rejected` sur health_professionals, `validated` sur
-- club_members) — déjà le seul usage constaté côté client (`sbValidatePro`/
-- équivalent club_members dans js/supabase-client.js).
--
-- Fix : même pattern que les triggers anti-tampering déjà en place — un
-- trigger `SECURITY DEFINER` (propriétaire `postgres`, `rolbypassrls=true`,
-- donc pas de risque de récursion RLS type 2026-07-23 sur `clubs`) qui remet
-- toute colonne hors du périmètre autorisé à sa valeur `OLD.*` quand
-- l'appelant est le club propriétaire (et non service_role, et non le
-- professionnel/membre lui-même sur ses propres champs via `pros_own`/
-- `member_self`, qui restent inchangés).
-- ----------------------------------------------------------------------------

-- 1. health_professionals : le club ne peut changer que validated_by_club/rejected.
CREATE OR REPLACE FUNCTION public.prevent_club_pro_tampering()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND EXISTS (
    SELECT 1 FROM clubs WHERE clubs.id = OLD.club_id AND clubs.user_id = auth.uid()
  ) THEN
    NEW.id           := OLD.id;
    NEW.user_id      := OLD.user_id;
    NEW.club_id      := OLD.club_id;
    NEW.profession   := OLD.profession;
    NEW.rpps         := OLD.rpps;
    NEW.created_at   := OLD.created_at;
    -- validated_by_club / rejected / updated_at restent modifiables : c'est
    -- précisément l'action de validation que la policy `pros_club_update` /
    -- `hp_club_validate` est censée permettre.
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.prevent_club_pro_tampering() SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_prevent_club_pro_tampering ON public.health_professionals;
CREATE TRIGGER trg_prevent_club_pro_tampering
  BEFORE UPDATE ON public.health_professionals
  FOR EACH ROW EXECUTE FUNCTION public.prevent_club_pro_tampering();

-- 2. club_members : même faille (numero_licence en clair), même fix.
CREATE OR REPLACE FUNCTION public.prevent_club_member_tampering()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND EXISTS (
    SELECT 1 FROM clubs WHERE clubs.id = OLD.club_id AND clubs.user_id = auth.uid()
  ) THEN
    NEW.id              := OLD.id;
    NEW.user_id         := OLD.user_id;
    NEW.club_id         := OLD.club_id;
    NEW.numero_licence  := OLD.numero_licence;
    NEW.created_at      := OLD.created_at;
    -- validated reste modifiable : action de validation du club.
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.prevent_club_member_tampering() SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_prevent_club_member_tampering ON public.club_members;
CREATE TRIGGER trg_prevent_club_member_tampering
  BEFORE UPDATE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.prevent_club_member_tampering();
