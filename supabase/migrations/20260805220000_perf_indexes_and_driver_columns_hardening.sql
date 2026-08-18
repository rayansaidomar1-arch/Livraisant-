-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — Audit sécurité + performances (2026-08-05, suite)
--
-- Ce fichier fait suite à un audit de sécurité et de performances mené après
-- la clôture des correctifs CRITIQUE/IMPORTANT de cette session. La plupart
-- des pistes remontées par cet audit ont été vérifiées puis écartées (faux
-- positifs — ex. `send-push` est déjà correctement authentifié, la RLS
-- `appt_patient_claim` est déjà atomique via UPDATE...WHERE patient_id IS
-- NULL donc protégée nativement contre la double réclamation concurrente par
-- le verrouillage de ligne Postgres, les données affichées dans la recherche
-- de substitution/conseils personnalisés sont des constantes JS statiques du
-- bundle — pas des données utilisateur ou base — donc non exploitables en
-- XSS). Deux pistes réelles restent à corriger ici :
--
-- 1. Index manquants sur `health_professionals(club_id)` et sur les colonnes
--    de filtrage fréquentes de `appointments` (pro_id, patient_id, et le
--    triplet club_id/patient_id IS NULL/status='pending' utilisé par
--    `sbGetOpenSlotsForClub` ET par la policy RLS `appt_open_read`). Ces deux
--    tables ne sont pas créées dans les migrations versionnées (schéma de
--    base pré-existant, comme `drivers`/`orders`/`pharmacies`) : on ne peut
--    pas garantir qu'un index y a été posé à la création. Ajout sans risque
--    (CREATE INDEX IF NOT EXISTS, gratuit si déjà présent).
--
-- 2. `drivers.ref_code` et `drivers.referrals` : utilisés par du code
--    pré-existant (`sbUpsertDriver` à l'inscription livreur, écrit
--    `ref_code`/`referrals`) et par la nouvelle RPC `my_driver_referral_stats()`
--    (migration 20260805210000, lit `ref_code`). Comme pour `health_professionals`
--    ci-dessus, `drivers` n'est pas créée dans les migrations versionnées —
--    on ne peut pas garantir avec certitude que ces colonnes existent déjà en
--    base. Ajout défensif idempotent : si elles existent déjà, cette
--    migration est un no-op ; sinon elle comble un manque qui ferait échouer
--    silencieusement l'upsert du dossier livreur et la RPC de stats de
--    parrainage.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Index de performance ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_health_professionals_club_id
  ON public.health_professionals(club_id);

CREATE INDEX IF NOT EXISTS idx_appointments_pro_id
  ON public.appointments(pro_id);

CREATE INDEX IF NOT EXISTS idx_appointments_patient_id
  ON public.appointments(patient_id);

-- Index partiel dédié : correspond exactement au filtre utilisé par
-- `sbGetOpenSlotsForClub()` (club_id + patient_id IS NULL + status='pending')
-- et à la condition de la policy RLS `appt_open_read` — les créneaux déjà
-- réclamés ou clôturés n'ont pas besoin d'y figurer, ce qui garde l'index
-- compact même quand l'historique des rendez-vous grossit.
CREATE INDEX IF NOT EXISTS idx_appointments_club_open_slots
  ON public.appointments(club_id)
  WHERE patient_id IS NULL AND status = 'pending';

-- ── 2. Colonnes livreur (défensif) ─────────────────────────────────────
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS ref_code text,
  ADD COLUMN IF NOT EXISTS referrals jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_ref_code_unique
  ON public.drivers(ref_code) WHERE ref_code IS NOT NULL;
