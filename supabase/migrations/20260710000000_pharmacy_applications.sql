-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — pharmacy_applications
-- Dossiers d'inscription pharmacie (formulaire public /pharmacie/inscription)
-- Avant cette migration, le formulaire ne persistait le dossier que dans le
-- localStorage du navigateur du pharmacien — jamais transmis à personne.
-- Cette table capture le dossier pour qu'un conseiller Livraisanté puisse le
-- consulter (Dashboard Supabase → Table Editor) et créer le compte pharmacie
-- (INSERT dans `pharmacies` + compte Auth) après vérification manuelle.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pharmacy_applications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nom                 text NOT NULL,
  rue                 text NOT NULL,
  cp                  text NOT NULL,
  ville               text NOT NULL,
  adresse             text,
  email               text,
  tel                 text,
  titulaire_prenom    text NOT NULL,
  titulaire_nom       text NOT NULL,
  titulaire_rpps      text NOT NULL,
  email_facturation   text NOT NULL,
  finess              text,
  siret               text,
  iban                text,
  plan                jsonb,
  status              text NOT NULL DEFAULT 'en_attente', -- en_attente | contactee | activee | refusee
  created_at          timestamptz DEFAULT now()
);

ALTER TABLE pharmacy_applications ENABLE ROW LEVEL SECURITY;

-- Le formulaire public (anon key) doit pouvoir créer un dossier, sans authentification
-- préalable (le compte pharmacie n'existe pas encore à ce stade).
DROP POLICY IF EXISTS "pharmacy_applications_public_insert" ON pharmacy_applications;
CREATE POLICY "pharmacy_applications_public_insert"
  ON pharmacy_applications FOR INSERT
  WITH CHECK (true);

-- Aucune policy SELECT/UPDATE/DELETE publique : seule l'équipe via le
-- Dashboard (service_role / propriétaire du projet, qui bypass RLS) peut lire
-- et traiter ces dossiers. Un anon ne peut donc jamais relire les dossiers
-- d'autres candidats (pas d'énumération de données).

CREATE INDEX IF NOT EXISTS idx_pharmacy_applications_status ON pharmacy_applications(status);
CREATE INDEX IF NOT EXISTS idx_pharmacy_applications_created ON pharmacy_applications(created_at DESC);
