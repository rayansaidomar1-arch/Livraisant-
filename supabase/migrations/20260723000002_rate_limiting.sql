-- ============================================================================
-- Correctif — rate-limiting basique pour les Edge Functions exposées (2026-07-23)
-- ============================================================================
-- Audit sécurité 2026-07-22, item Moyen : « Aucun rate-limiting sur send-push,
-- send-email, create-payment-intent ». Ces 3 fonctions appellent des services
-- tiers payants/à quota (Web Push, Resend, Stripe) — sans limite, un compte
-- compromis, un bug côté client en boucle, ou un abus du formulaire public de
-- candidature pharmacie (`send-email` / candidature_pharmacie, sans auth) peut
-- générer un volume d'appels coûteux ou nuisible (spam de notifications/emails,
-- création de PaymentIntents Stripe en boucle).
--
-- Implémentation : compteur glissant simple en base (table + fonction
-- SECURITY DEFINER, même pattern que les autres helpers cross-table de ce
-- projet — bypass RLS via le rôle propriétaire `postgres`, qui a
-- `rolbypassrls=true`, donc pas de risque de récursion RLS). Verrou
-- (`pg_advisory_xact_lock`) sur le bucket pour éviter une course entre deux
-- requêtes concurrentes du même utilisateur.
--
-- Ce n'est pas un rate-limiter distribué/production-grade (pas de sharding, la
-- table grossit avec le trafic — un nettoyage paresseux a lieu à chaque appel,
-- suffisant vu le volume actuel du site), mais ça couvre le scénario réel
-- identifié par l'audit : un appelant qui spamme un endpoint depuis un seul
-- compte/une seule IP.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
  id bigserial PRIMARY KEY,
  bucket text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_bucket_created ON public.rate_limit_hits (bucket, created_at);

-- RLS activée sans aucune policy : seul le rôle service_role (bypass RLS) ou
-- cette fonction SECURITY DEFINER peuvent lire/écrire cette table — jamais un
-- patient/pharmacie/livreur authentifié directement.
ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_bucket text, p_max_hits int, p_window_seconds int)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  -- Sérialise les appels concurrents pour le même bucket (même utilisateur/IP)
  -- le temps de cette transaction, pour éviter une course check-puis-insert.
  PERFORM pg_advisory_xact_lock(hashtext(p_bucket));

  -- Nettoyage paresseux : ne coûte que sur ce bucket précis, pas de scan global.
  DELETE FROM public.rate_limit_hits
    WHERE bucket = p_bucket AND created_at < now() - make_interval(secs => p_window_seconds);

  SELECT count(*) INTO v_count FROM public.rate_limit_hits WHERE bucket = p_bucket;
  IF v_count >= p_max_hits THEN
    RETURN false;
  END IF;

  INSERT INTO public.rate_limit_hits (bucket) VALUES (p_bucket);
  RETURN true;
END;
$$;
ALTER FUNCTION public.check_rate_limit(text, int, int) SET search_path = public, pg_temp;
