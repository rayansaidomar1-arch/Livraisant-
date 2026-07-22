-- ============================================================================
-- Livraisanté — Policy manquante : validation des candidatures pharmacie (2026-07-22)
--
-- Contexte : un utilisateur admin a signalé ne pas pouvoir « valider [un] compte
-- pharmacien ». Investigation : le formulaire multi-étapes de candidature
-- (#pharmacySignup, index.html) écrit bien dans `pharmacy_applications` avec
-- `status='en_attente'` et promet à l'utilisateur qu'« un conseiller Livraisanté
-- [le] contactera dans les 24h ». Mais aucune interface admin (ni admin.html, ni
-- le dashboard admin intégré à index.html) n'a jamais affiché ces candidatures,
-- et il n'existait même pas de policy RLS UPDATE pour permettre à un admin de
-- changer leur statut. Autrement dit : la promesse faite au candidat ne pouvait
-- objectivement jamais être tenue — corrigé ici (policy) + côté front (voir
-- commit associé ajoutant l'onglet « Candidatures pharmacie »).
-- ============================================================================

DROP POLICY IF EXISTS "pharmacy_applications_admin_update" ON public.pharmacy_applications;
CREATE POLICY "pharmacy_applications_admin_update"
  ON public.pharmacy_applications FOR UPDATE
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
