-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — Correctif escalade admin à l'inscription + régression OAuth
-- (2026-07-17)
--
-- Contexte : la migration 20260716000000 a posé un trigger qui bloque TOUT
-- changement de `profiles.role` par un utilisateur connecté (sauf
-- service_role). Objectif initial atteint (plus d'auto-promotion admin via
-- UPDATE), MAIS effet de bord découvert : `confirmOAuthRole()` (index.html),
-- qui fait un UPDATE profiles.role juste après une 1ère connexion Google pour
-- laisser l'utilisateur choisir pharmacien/livreur/professionnel_sante/club,
-- est désormais silencieusement annulé lui aussi (NEW.role := OLD.role).
--
-- Par ailleurs, on a confirmé que `handle_new_user` (trigger AFTER INSERT ON
-- auth.users, créé via Dashboard, hors dépôt) fait :
--   INSERT INTO profiles(..., role) VALUES (..., COALESCE(raw_user_meta_data->>'role','patient'))
-- => un simple appel console `supabase.auth.signUp({..., options:{data:{role:'admin'}}})`
-- suffit à créer un compte admin dès l'inscription, sans jamais passer par le
-- trigger UPDATE. C'est la vraie faille critique à corriger.
--
-- Correctif :
-- 1. handle_new_user : liste blanche de rôles auto-déclarables à l'inscription
--    (jamais 'admin'). Toute valeur hors liste retombe sur 'patient'.
-- 2. prevent_role_self_escalation : autorise UNE SEULE transition
--    patient/patient_licencie → { pharmacien, livreur, professionnel_sante,
--    club, patient_licencie } (le choix fait une fois via confirmOAuthRole
--    ou équivalent), mais jamais vers 'admin', et bloque toute modification
--    ultérieure une fois le rôle déjà fixé à autre chose que patient.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. handle_new_user — liste blanche à l'inscription ─────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $function$
DECLARE
  requested_role text := NEW.raw_user_meta_data->>'role';
  safe_role text;
BEGIN
  IF requested_role = ANY (ARRAY['patient','patient_licencie','pharmacien','livreur','professionnel_sante','club']) THEN
    safe_role := requested_role;
  ELSE
    safe_role := 'patient';
  END IF;

  INSERT INTO public.profiles(id, email, prenom, nom, role)
  VALUES (
    NEW.id, NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'prenom', ''),
    COALESCE(NEW.raw_user_meta_data->>'nom', ''),
    safe_role
  );
  RETURN NEW;
END;
$function$ LANGUAGE plpgsql SECURITY DEFINER;
-- Note : CREATE OR REPLACE suffit, le trigger AFTER INSERT ON auth.users
-- existant (créé via Dashboard) référence cette fonction par son nom et
-- utilisera automatiquement la nouvelle version — pas besoin de le recréer.

-- ── 2. prevent_role_self_escalation — autorise 1 seul choix de rôle non-admin ──
CREATE OR REPLACE FUNCTION prevent_role_self_escalation()
RETURNS trigger AS $$
DECLARE
  allowed_self_roles text[] := ARRAY['patient','patient_licencie','pharmacien','livreur','professionnel_sante','club'];
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF auth.role() = 'service_role' THEN
      -- Edge Function admin / backoffice : autorisé sans restriction
      NULL;
    ELSIF OLD.role IN ('patient','patient_licencie')
          AND NEW.role = ANY (allowed_self_roles) THEN
      -- 1er choix de rôle par l'utilisateur (ex: confirmOAuthRole juste après
      -- une 1ère connexion Google) : autorisé une seule fois, jamais vers 'admin'
      -- ('admin' n'est de toute façon pas dans allowed_self_roles).
      NULL;
    ELSE
      NEW.role := OLD.role;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
-- Le trigger trg_prevent_role_self_escalation (posé par 20260716000000)
-- référence déjà cette fonction par son nom — pas besoin de le recréer non plus.
