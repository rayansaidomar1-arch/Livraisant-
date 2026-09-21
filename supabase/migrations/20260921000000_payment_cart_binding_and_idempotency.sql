-- ============================================================================
-- Correctifs audit sécurité paiement (2026-09-21) — failles 1 et 3
-- ============================================================================
-- Contexte : audit du 2026-09-21. Trois failles de paiement ont été confirmées
-- dans le code des Edge Functions. Cette migration porte l'infrastructure
-- nécessaire à deux d'entre elles (la troisième — devise choisie par le client —
-- se corrige entièrement dans create-payment-intent/index.ts).
--
-- ── Faille 1 : le panier n'était pas lié au paiement ────────────────────────
-- `create-payment-intent` calculait le montant à partir d'un panier A (relu
-- depuis le catalogue `products`), puis `confirm-order` enregistrait le panier
-- B envoyé dans le corps de la requête, sans jamais recouper les deux :
--
--   POST create-payment-intent {items:[1 article à 0,50 €]}  → payer 0,55 €
--   POST confirm-order         {paymentIntentId, items:[30 articles chers]}
--
-- La commande créée portait les 30 articles, la pharmacie les préparait et les
-- livrait, pour 0,55 € encaissés. Le montant était bien relu depuis Stripe :
-- c'est le *contenu* du panier qui n'était contraint par rien.
--
-- Fix : `create-payment-intent` enregistre ici le panier canonique — celui-là
-- même qui a servi au calcul du montant — et `confirm-order` le relit depuis
-- cette table au lieu de faire confiance au corps de la requête. Le client
-- n'envoie plus de panier du tout au moment de la confirmation.
--
-- Cette table est volontairement SANS AUCUNE POLICY tout en ayant la RLS
-- activée : c'est la forme la plus stricte (aucun accès pour anon ni
-- authenticated, y compris en lecture ; seul service_role, qui contourne la
-- RLS, y accède depuis les deux Edge Functions). Un panier révèle des produits
-- de santé commandés — donnée de l'article 9 RGPD.
--
-- ── Faille 3 : idempotence contournable → cagnotte créditée en double ───────
-- `confirm-order` protégeait le rejeu par un SELECT suivi d'un INSERT, avec un
-- `id` de commande CHOISI PAR LE CLIENT. Deux requêtes concurrentes portant le
-- même paymentIntentId et deux `id` différents passaient toutes les deux le
-- SELECT (TOCTOU) et s'inséraient. Chaque doublon recréditait
-- `club_cagnotte_entries` (dont la contrainte UNIQUE porte sur `order_id`, donc
-- ne voyait aucun doublon) : un seul paiement pouvait reverser N fois au club.
--
-- Fix : la contrainte devient atomique et portée par la base — le seul endroit
-- où une garantie d'unicité tient sous concurrence. L'index partiel laisse
-- passer les commandes gratuites (kind='sportif'), qui n'ont pas de paiement.
-- ----------------------------------------------------------------------------

-- 1. Panier canonique lié au PaymentIntent -----------------------------------
CREATE TABLE IF NOT EXISTS public.payment_carts (
  payment_intent_id text PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pharmacy_id       text NOT NULL,
  delivery_mode     text NOT NULL CHECK (delivery_mode IN ('livraison','cnc','cnc_club')),
  items             jsonb NOT NULL,
  amount_cents      integer NOT NULL CHECK (amount_cents >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_carts IS
  'Panier canonique (lab+name résolus depuis products) ayant servi au calcul du montant Stripe. Écrit par create-payment-intent, relu par confirm-order. Accès service_role uniquement.';

CREATE INDEX IF NOT EXISTS idx_payment_carts_user ON public.payment_carts(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_carts_created ON public.payment_carts(created_at);

-- RLS activée SANS policy = aucun accès pour anon/authenticated.
ALTER TABLE public.payment_carts ENABLE ROW LEVEL SECURITY;

-- Ceinture et bretelles : même si une policy était ajoutée par erreur plus tard,
-- les droits de table ne sont pas accordés aux rôles clients.
REVOKE ALL ON public.payment_carts FROM anon, authenticated;

-- 2. Idempotence atomique du paiement ----------------------------------------
-- NB : si cet index échoue à la création, c'est qu'il existe DÉJÀ des commandes
-- en double sur un même PaymentIntent en production — c'est-à-dire que la faille
-- a été exploitée, ou qu'un double-clic est passé. Dans ce cas, ne pas forcer :
-- identifier les doublons avec la requête ci-dessous, les traiter, puis rejouer.
--
--   SELECT payment->>'paymentIntentId' AS pi, count(*), array_agg(id)
--   FROM public.orders
--   WHERE payment->>'paymentIntentId' IS NOT NULL
--   GROUP BY 1 HAVING count(*) > 1;
--
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_intent_unique
  ON public.orders ((payment->>'paymentIntentId'))
  WHERE payment->>'paymentIntentId' IS NOT NULL;

-- 3. Purge des paniers orphelins ---------------------------------------------
-- Un panier dont le paiement n'a jamais abouti reste sinon indéfiniment en base
-- (donnée de santé conservée sans finalité — art. 5.1.e RGPD, minimisation).
-- Même approche que cleanup_expired_signup_verifications (20260805000000).
CREATE OR REPLACE FUNCTION public.cleanup_stale_payment_carts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM public.payment_carts
   WHERE created_at < now() - interval '30 days'
     AND NOT EXISTS (
       SELECT 1 FROM public.orders o
        WHERE o.payment->>'paymentIntentId' = payment_carts.payment_intent_id
     );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
ALTER FUNCTION public.cleanup_stale_payment_carts() SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.cleanup_stale_payment_carts() FROM anon, authenticated;
