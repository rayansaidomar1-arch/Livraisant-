-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — Branchement réel du flux commandes (2026-07-18)
--
-- Contexte : jusqu'ici, index.html gérait TOUTES les commandes en mémoire
-- + localStorage (`ORDERS` / clé `livraisante_orders`), synchronisées entre
-- onglets d'un même navigateur uniquement via BroadcastChannel. Aucune
-- commande n'était jamais écrite dans la table `orders` de Supabase — une
-- pharmacie et un livreur sur deux appareils différents ne voyaient donc
-- jamais les mêmes commandes. Ce fichier prépare le terrain côté base pour
-- brancher réellement index.html sur `orders` (déjà vide, 0 ligne, RLS déjà
-- en place depuis 20260624/20260711/20260718000001) :
--
-- 1. `orders.arrival` — colonne manquante pour le suivi Click & Collect
--    (checked-in, position, distance, heure d'arrivée) : utilisée par
--    confirmCheckIn()/markServed()/renderArrivalNotifications() côté client,
--    absente du schéma actuel.
-- 2. `pharmacies.lat/lon/horaires` — colonnes manquantes utilisées par
--    renderPharmacyCard() (lien carte, itinéraire, horaires affichés au
--    patient) mais jamais persistées côté Supabase (elles n'existaient
--    jusqu'ici que dans l'ancien système 100% localStorage `getAccounts()`).
-- 3. Vue publique `pharmacies_public` — un patient doit pouvoir parcourir
--    les pharmacies partenaires pour passer commande, mais la table
--    `pharmacies` n'a plus aucune policy de lecture publique (corrigée à
--    dessein pour ne pas exposer IBAN/SIRET/RPPS à tout le monde). Cette vue
--    n'expose que les colonnes réellement publiques (nom, adresse, contact,
--    horaires, config catalogue) — même principe déjà utilisé pour
--    `orders_driver_available` (migration 20260711000000).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. orders.arrival ──────────────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS arrival jsonb;

-- ── 2. pharmacies — coordonnées + horaires publics ─────────────────────
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS lon double precision;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS horaires text;

-- ── 3. Vue publique pharmacies (lecture patient) ────────────────────────
-- DROP nécessaire : une version antérieure de cette vue (colonnes
-- différentes, créée hors migration versionnée) existait déjà en prod.
-- CREATE OR REPLACE VIEW n'autorise pas de changer les colonnes d'une vue.
DROP VIEW IF EXISTS pharmacies_public;
CREATE VIEW pharmacies_public AS
  SELECT id, nom, adresse, ville, cp, tel, lat, lon, horaires,
         catalog_mode, active_labs, priority_mode, priority_labs, active_substances
  FROM pharmacies;

GRANT SELECT ON pharmacies_public TO anon, authenticated;

-- Note : cette vue ne remplace aucune policy existante sur `pharmacies` —
-- `pharma_own`/`pharma_admin_read` continuent de protéger les colonnes
-- sensibles (iban, siret, rpps, finess, email, plan, plan_name) qui restent
-- réservées au titulaire de l'officine et à l'admin.
