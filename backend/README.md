# ⚠️ Statut : non utilisé par le site en production

Ce dossier contient une API Node.js/Express + Prisma, pensée à l'origine pour
un hébergement HDS (Clever Cloud) avec sa propre base PostgreSQL. **Elle n'est
pas branchée sur le site réel.**

## Ce qui tourne réellement en production

Le site (`index.html`, `admin.html`, `js/supabase-client.js`, servis en
statique depuis GitHub Pages) parle **directement à Supabase** :
authentification, base de données (Postgres géré par Supabase, avec Row Level
Security), et Edge Functions le cas échéant. Aucune requête du front-end ne
pointe vers ce `backend/` ni vers une URL Clever Cloud — vous pouvez le
vérifier vous-même : `grep -rn "backend\|clevercloud" index.html
js/supabase-client.js` ne renvoie aucun appel réseau vers ce dossier.

## Pourquoi il existe encore

- `backend/prisma/schema.prisma` pointe sur `DATABASE_URL` (un add-on
  PostgreSQL Clever Cloud), **une base totalement différente** de celle de
  Supabase utilisée par le site. Même si ce service tournait, il écrirait
  dans une base que le front-end ne lit jamais.
- Il contient des templates d'emails (`backend/templates/*.html`) et de la
  logique métier (signup, reset password, JWT) qui a été, depuis, réimplémentée
  côté Supabase (Auth + RLS + fonctions `SECURITY DEFINER`, voir
  `supabase/migrations/`).

## À faire avant de le réactiver un jour (si besoin)

Si ce backend doit un jour être remis en service (par ex. pour des tâches
serveur que Supabase ne couvre pas bien — jobs planifiés lourds, intégration
tierce spécifique), il faudra au minimum :

1. Décider s'il doit lire/écrire dans la base Supabase (via `SUPABASE_DB_URI`,
   déjà présent dans `backend/.env`) plutôt que dans son propre add-on
   PostgreSQL, pour éviter d'avoir deux bases divergentes.
2. Documenter/exposer ses endpoints dans le front-end (actuellement aucun
   n'est appelé).
3. Revoir les secrets présents dans `backend/.env` (rotation recommandée
   avant toute remise en service, dans le doute).

En l'état, ce dossier peut être ignoré sans risque pour le fonctionnement du
site — c'est de la dette technique documentée, pas un système actif.
