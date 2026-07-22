# Registre des activités de traitement — Livraisanté SAS

**Établi conformément à l'article 30 du RGPD.**

---

## ⚠️ Avertissement — à lire avant utilisation

Ce registre a été **rédigé automatiquement à partir d'une analyse technique du code et de la
base de données** de l'application Livraisanté (schéma Supabase, Edge Functions, politique de
confidentialité déjà publiée sur le site). Il couvre fidèlement ce qui est *techniquement*
collecté et traité aujourd'hui (22/07/2026).

Ce n'est **pas un avis juridique**, et ce n'est pas non plus, en l'état, un document opposable :
- Les **durées de conservation** proposées reprennent celles déjà annoncées dans la politique de
  confidentialité du site (`showRgpdModal('intro')`, index.html) quand elles existaient, et sont
  **estimées par défaut sur des durées usuelles** ailleurs — à valider ou corriger.
- Les **mesures de sécurité** listées sont celles effectivement observées dans le code (RLS,
  chiffrement en transit, etc.) — pas un audit de sécurité complet.
- Ce registre **doit être relu, complété et tenu à jour par la personne responsable de la
  protection des données** chez Livraisanté (DPO désigné, ou à défaut le dirigeant en tant que
  responsable de traitement), qui reste seule responsable de son exactitude devant la CNIL.
- **Chaque traitement lié au paiement (Stripe) et à l'envoi d'email (Resend) implique un transfert
  de données à un sous-traitant** — les clauses contractuelles (DPA — Data Processing Agreement)
  avec chacun d'eux doivent être signées séparément ; ce registre ne s'y substitue pas.

**À mettre à jour** à chaque ajout de fonctionnalité qui traite une nouvelle catégorie de données,
ajoute un nouveau sous-traitant, ou change une finalité.

---

## Responsable de traitement

| | |
|---|---|
| Raison sociale | Livraisanté SAS |
| Forme juridique | Société par actions simplifiée (SAS) |
| Siège social | 1 Rue des Vergers, 69120 Vaulx-en-Velin |
| RCS | 933 484 917 R.C.S. Lyon |
| Représentant légal | Archad Sidi Saïd Omar, Président |
| Contact données personnelles | `administratif@livraisante.fr` — **à activer**, voir note ci-dessous |

> **Note DPO (mise à jour 2026-07-22) :** la politique de confidentialité référençait jusqu'ici
> `dpo@livraisante.fr` comme contact « DPO », alors que l'utilisateur (dirigeant de Livraisanté) a
> confirmé qu'aucun DPO n'est activement désigné et que cette adresse n'existe pas. Deux corrections
> ont été apportées le 22/07/2026 :
> 1. **Le site (`index.html`, 4 occurrences dans `showRgpdModal()` et le formulaire d'inscription)
>    ne revendique plus l'existence d'un DPO** — le libellé a été changé en « Contact protection
>    des données », ce qui est plus exact : le RGPD n'impose un DPO obligatoire (Art. 37) que pour
>    les organismes publics ou les traitements à grande échelle de données sensibles ; à ce stade,
>    Livraisanté n'est pas tenue d'en désigner un formellement, mais reste tenue de fournir un point
>    de contact fonctionnel pour l'exercice des droits (Art. 13-14 RGPD) — ce qui est fait.
> 2. **L'adresse a été changée pour `administratif@livraisante.fr`** (au lieu de `dpo@livraisante.fr`,
>    pour ne pas laisser une adresse au nom trompeur si aucun DPO n'est désigné).
>
> ⚠️ **Action restant à la charge du dirigeant (hors code, ne peut pas être faite depuis ce dépôt) :**
> cette adresse doit être **rendue réellement fonctionnelle** — créer une redirection email
> (« alias ») `administratif@livraisante.fr` → une boîte mail réellement consultée, depuis le panneau de
> gestion du domaine `livraisante.fr` (OVH/Gandi, section « Emails » ou « Redirections », gratuit,
> ~2 minutes, aucune ligne de code). Tant que ce n'est pas fait, les demandes d'exercice de droits
> RGPD envoyées à cette adresse resteront sans réponse. Si un DPO est désigné plus tard (recommandé
> vu la sensibilité des données de santé traitées), remettre à jour ce registre et le site en
> conséquence.

---

## Sous-traitants (destinataires techniques communs à plusieurs traitements)

| Sous-traitant | Rôle | Localisation | Données concernées |
|---|---|---|---|
| Supabase (infra AWS eu-west-3, Paris) | Hébergement base de données, authentification, stockage, fonctions serveur | UE (Paris) | Toutes les données applicatives |
| GitHub Inc. (GitHub Pages) | Hébergement statique du site (HTML/JS/CSS, aucune donnée personnelle en base côté GitHub) | US (CDN global) | Aucune donnée personnelle stockée — sert uniquement le code statique |
| Stripe | Traitement des paiements par carte | UE/US (Stripe Payments Europe Ltd, clauses contractuelles types) | Montant, devise, email/nom du payeur, 4 derniers chiffres carte (Stripe uniquement — jamais transmis à Livraisanté) |
| Resend | Envoi des emails transactionnels (confirmation compte, commande, etc.) | À vérifier (US ou UE selon config Resend) | Adresse email, contenu de l'email (peut inclure des informations de commande) |
| Sentry | Suivi des erreurs applicatives (monitoring) | À vérifier selon config | Traces techniques, potentiellement IP, parfois des identifiants utilisateur en cas d'erreur |
| Google Analytics 4 / Plausible | Mesure d'audience | GA4 : US (si activé, soumis consentement) / Plausible : sans cookie, IP anonymisée | Données de navigation anonymisées |

> **À vérifier par le DPO :** localisation exacte des serveurs Resend et Sentry utilisés (UE ou
> hors UE) — si hors UE, il faut des clauses contractuelles types (SCC) signées, ce registre ne
> peut pas confirmer cela depuis le code seul.

---

## Fiche 1 — Gestion des comptes utilisateurs

| Champ | Détail |
|---|---|
| **Finalité** | Créer et gérer les comptes patients, pharmacies, livreurs, clubs sportifs et professionnels de santé ; authentification |
| **Base légale** | Exécution du contrat (Art. 6§1b) — nécessaire pour fournir le service |
| **Personnes concernées** | Patients, pharmaciens titulaires, livreurs indépendants, responsables de clubs, professionnels de santé |
| **Données traitées** | Identité (prénom, nom), email, téléphone, rôle, mot de passe (haché par Supabase Auth, jamais en clair) |
| **Table(s)** | `profiles`, Supabase Auth |
| **Destinataires** | Supabase (hébergeur technique) ; aucune cession à des tiers |
| **Durée de conservation** | Durée de vie du compte + 3 ans après la dernière connexion, puis suppression ou anonymisation |
| **Sécurité** | RLS activée (chacun ne lit/modifie que sa propre ligne, sauf admin) ; mots de passe hachés par Supabase Auth (non stockés en clair) ; connexion chiffrée (HTTPS/TLS) |
| **Transfert hors UE** | Non (Supabase hébergé en UE) |

---

## Fiche 2 — Profil de santé patient ⚠️ Données sensibles (Art. 9 RGPD)

| Champ | Détail |
|---|---|
| **Finalité** | Personnaliser le conseil pharmaceutique (âge, grossesse, traitements chroniques, poids/taille) pour orienter vers des produits adaptés et signaler les contre-indications |
| **Base légale** | **Consentement explicite et spécifique** (Art. 9§2a RGPD) — recueilli via case à cocher dédiée, distincte des CGU, lors de l'inscription |
| **Personnes concernées** | Patients |
| **Données traitées** | Tranche d'âge, grossesse (oui/non), sexe, traitements/médicaments en cours, poids, taille, IMC, adresse (pour la triage géographique) — **catégorie spéciale de données de santé** |
| **Table(s)** | `profiles.health_profile` (jsonb) |
| **Destinataires** | Le pharmacien de l'officine qui traite la commande du patient concerné, uniquement dans le cadre de cette prise en charge. Aucune cession commerciale à des tiers. |
| **Durée de conservation** | 3 ans après la dernière connexion (annoncé dans la politique de confidentialité) |
| **Sécurité** | RLS : lecture/écriture strictement limitée à `auth.uid() = id` (le patient lui-même) côté serveur ; le pharmacien accède aux données du patient uniquement via la commande associée (jointure sur `orders`), pas un accès direct et permanent à `profiles` |
| **Transfert hors UE** | Non |
| **Point d'attention pour le DPO** | Le consentement Art. 9 est recueilli **une fois, à l'inscription** — vérifier qu'un mécanisme permet bien de le retirer à tout moment comme l'annonce la politique de confidentialité (aujourd'hui : uniquement par email au contact DPO, à automatiser si possible) |

---

## Fiche 3 — Commandes de produits (compléments alimentaires, dispositifs médicaux)

| Champ | Détail |
|---|---|
| **Finalité** | Traiter, livrer et facturer les commandes de compléments alimentaires (CA) et dispositifs médicaux (DM) |
| **Base légale** | Exécution du contrat (Art. 6§1b) ; obligation légale comptable pour la conservation des factures (Art. 6§1c) |
| **Personnes concernées** | Patients |
| **Données traitées** | Articles commandés (nom produit — peut indirectement révéler une information de santé selon le produit, ex. compléments grossesse), montant, statut, adresse ou point de retrait, position GPS de livraison (non conservée au-delà de la livraison), mode de livraison |
| **Table(s)** | `orders` |
| **Destinataires** | Pharmacie partenaire (préparation), livreur assigné (adresse de livraison uniquement) |
| **Durée de conservation** | 5 ans (obligation légale comptable — annoncé dans la politique de confidentialité) |
| **Sécurité** | RLS : le patient ne voit que ses commandes ; la pharmacie ne voit que les commandes qui lui sont adressées ; le livreur ne voit que les commandes qui lui sont assignées ; trigger serveur empêchant un livreur de modifier le contenu/prix d'une commande après création |
| **Transfert hors UE** | Non |
| **Point d'attention pour le DPO** | Depuis le 22/07/2026, le nom des produits n'est plus transmis à Stripe (metadata) — seul le nombre d'articles l'est, pour limiter la diffusion d'informations de santé indirectes à ce sous-traitant |

---

## Fiche 4 — Paiement en ligne (Stripe)

| Champ | Détail |
|---|---|
| **Finalité** | Encaissement du prix des commandes |
| **Base légale** | Exécution du contrat (Art. 6§1b) |
| **Personnes concernées** | Patients |
| **Données traitées** | Montant, devise, email/nom du payeur, nombre d'articles (métadonnée). **Aucune donnée bancaire (numéro de carte, CVV) n'est stockée ou même transmise à Livraisanté** — la saisie et le traitement de la carte sont intégralement gérés par Stripe (Stripe Elements) |
| **Destinataire / sous-traitant** | Stripe Payments Europe Ltd |
| **Durée de conservation** | Statut de paiement conservé avec la commande (5 ans, cf. Fiche 3) ; Stripe conserve les données de paiement selon sa propre politique |
| **Sécurité** | PCI-DSS assuré par Stripe (Livraisanté ne manipule jamais la donnée carte) ; montant recalculé côté serveur depuis le catalogue produit avant tout PaymentIntent (corrigé le 22/07/2026 — évite qu'un montant falsifié soit transmis à Stripe) |
| **Transfert hors UE** | Selon les clauses contractuelles types Stripe (à vérifier dans le DPA Stripe signé) |

---

## Fiche 5 — Gestion des pharmacies partenaires

| Champ | Détail |
|---|---|
| **Finalité** | Référencer et faire fonctionner les officines partenaires (réception de commandes, facturation, règlement) |
| **Base légale** | Exécution du contrat (Art. 6§1b) |
| **Personnes concernées** | Pharmaciens titulaires et leur officine |
| **Données traitées** | Nom, adresse, téléphone, email, n° FINESS, n° RPPS du titulaire, n° d'inscription à l'Ordre, SIRET, RCS, IBAN (pour règlement des commandes) |
| **Table(s)** | `pharmacies`, `pharmacy_applications` (candidatures en attente de validation admin) |
| **Destinataires** | Équipe administrative Livraisanté (validation des candidatures) |
| **Durée de conservation** | Durée du partenariat + 5 ans (obligations comptables liées à l'IBAN/facturation) ; candidatures rejetées : à purger après un délai raisonnable (recommandé : 2 ans) |
| **Sécurité** | RLS : la pharmacie ne voit que ses propres données ; seul un admin peut valider/rejeter une candidature (policy ajoutée le 22/07/2026) |
| **Transfert hors UE** | Non |

---

## Fiche 6 — Gestion des livreurs indépendants

| Champ | Détail |
|---|---|
| **Finalité** | Référencer les livreurs, leur attribuer des courses, les rémunérer |
| **Base légale** | Exécution du contrat (Art. 6§1b) |
| **Personnes concernées** | Livreurs indépendants |
| **Données traitées** | SIRET, IBAN, véhicule, zone de livraison (km max), créneaux de disponibilité, statut d'activation, code de parrainage |
| **Table(s)** | `drivers` |
| **Destinataires** | Équipe administrative Livraisanté |
| **Durée de conservation** | Durée du partenariat + 5 ans (obligations comptables) |
| **Sécurité** | RLS ; trigger serveur empêchant un livreur de s'auto-activer (`prevent_driver_self_activation`) |
| **Transfert hors UE** | Non |

---

## Fiche 7 — Clubs sportifs, licenciés et professionnels de santé affiliés

| Champ | Détail |
|---|---|
| **Finalité** | Gérer le programme B2B2C avec les clubs sportifs (Click & Collect au club, cagnotte, adhésion des licenciés) et l'affiliation de professionnels de santé |
| **Base légale** | Exécution du contrat (Art. 6§1b) ; consentement pour la donnée de santé indirecte (licence sportive pouvant révéler une pratique sportive) |
| **Personnes concernées** | Responsables de clubs, licenciés (patients), professionnels de santé affiliés à un club |
| **Données traitées** | Nom du club, ville, fédération, SIRET, numéro de licence sportive du patient, profession réglementée + n° RPPS pour les professionnels de santé |
| **Table(s)** | `clubs`, `club_members`, `club_join_requests`, `health_professionals` |
| **Destinataires** | Le club concerné (pour valider ses licenciés/professionnels affiliés) |
| **Durée de conservation** | Durée de l'affiliation + 3 ans |
| **Sécurité** | RLS ; trigger serveur empêchant un licencié de s'auto-valider (`prevent_member_self_validation`, vérifié le 22/07/2026) |
| **Transfert hors UE** | Non |

---

## Fiche 8 — Notifications push

| Champ | Détail |
|---|---|
| **Finalité** | Envoyer des notifications (suivi de commande, validation de compte, etc.) |
| **Base légale** | Exécution du contrat / intérêt légitime (notifications strictement liées au service, pas de prospection) |
| **Personnes concernées** | Tous les utilisateurs ayant activé les notifications |
| **Données traitées** | Point de terminaison (« endpoint ») d'abonnement push du navigateur, clés cryptographiques associées (p256dh, auth) — ne contiennent pas de contenu de message |
| **Table(s)** | `push_subscriptions` |
| **Destinataires** | Services de push des navigateurs (Google/Mozilla/Apple selon le navigateur de l'utilisateur), techniquement nécessaires à l'acheminement |
| **Durée de conservation** | Jusqu'à désinscription ou suppression du compte |
| **Sécurité** | RLS (chacun ne gère que son propre abonnement) ; chiffrement de bout en bout VAPID (standard Web Push) |
| **Transfert hors UE** | Dépend du service de push du navigateur utilisé par la personne (hors du contrôle de Livraisanté) |

---

## Fiche 9 — Mesure d'audience et supervision technique

| Champ | Détail |
|---|---|
| **Finalité** | Mesurer la fréquentation du site, détecter et corriger les bugs |
| **Base légale** | Intérêt légitime pour la mesure d'audience anonymisée (exemptée de consentement — délibération CNIL 2020-091) ; consentement pour Google Analytics 4 (non anonyme par défaut, chargé uniquement après consentement, cf. bandeau cookies) |
| **Personnes concernées** | Tout visiteur du site |
| **Données traitées** | Événements applicatifs anonymisés (`app_events`), IP (anonymisée pour GA4), erreurs techniques (Sentry, peut occasionnellement contenir un identifiant utilisateur en cas d'erreur applicative) |
| **Table(s) / outils** | `app_events`, Google Analytics 4, Plausible, Sentry |
| **Destinataires** | Google (GA4, hors UE — soumis consentement), Plausible (sans cookie), Sentry |
| **Durée de conservation** | `app_events` : recommandé 13 mois maximum (aligné sur les recommandations CNIL pour la mesure d'audience) — **à confirmer/purger, aucune purge automatique n'a été identifiée dans le code actuel** |
| **Sécurité** | RLS sur `app_events` (insertion par l'utilisateur concerné uniquement) |
| **Transfert hors UE** | GA4 : oui (Google LLC, US) — soumis au consentement explicite du bandeau cookies |

---

## Fiche 10 — Règlements et facturation pharmacie/livreur

| Champ | Détail |
|---|---|
| **Finalité** | Établir les règlements périodiques (virements) aux pharmacies et calculer la facturation |
| **Base légale** | Exécution du contrat + obligation légale comptable |
| **Personnes concernées** | Pharmacies partenaires |
| **Données traitées** | Montants HT/TVA/TTC, numéro de facture, liste des commandes concernées |
| **Table(s)** | `settlements` |
| **Destinataires** | Comptabilité Livraisanté |
| **Durée de conservation** | 10 ans (obligation légale de conservation des documents comptables — Art. L123-22 Code de commerce) |
| **Sécurité** | RLS (accès admin + pharmacie concernée uniquement) |
| **Transfert hors UE** | Non |

---

## Fiche 11 — Codes promotionnels et parrainage

| Champ | Détail |
|---|---|
| **Finalité** | Gérer les campagnes de codes promo et le programme de parrainage livreurs/patients |
| **Base légale** | Exécution du contrat / intérêt légitime commercial |
| **Personnes concernées** | Utilisateurs bénéficiaires de codes promo, parrains/filleuls |
| **Données traitées** | Code, type de réduction, nombre d'utilisations, identifiant du créateur du code (admin) |
| **Table(s)** | `promo_codes`, `referrals` (jsonb dans `drivers`) |
| **Durée de conservation** | Durée de la campagne + 3 ans |
| **Sécurité** | RLS (écriture réservée aux admins) |
| **Transfert hors UE** | Non |

---

## Synthèse — actions restant à faire pour que ce registre soit complet et exploitable

1. ~~Corriger le contact « DPO » sur le site~~ — fait le 22/07/2026 (libellé corrigé + adresse changée en `administratif@livraisante.fr`). **Reste à faire par le dirigeant, hors code : activer réellement cette adresse** (redirection email depuis le panneau OVH/Gandi du domaine) — voir note en tête de document.
2. **Confirmer/purger la durée de rétention de `app_events`** — aucune purge automatique identifiée dans le code ; recommandé 13 mois glissants.
3. **Confirmer la localisation des sous-traitants Resend et Sentry** (UE ou hors UE) et vérifier l'existence de clauses contractuelles types (SCC) si hors UE.
4. **Vérifier que les DPA (Data Processing Agreements) sont bien signés** avec Supabase, Stripe, Resend, Sentry.
5. **Vérifier le mécanisme concret d'exercice des droits** (accès, effacement, portabilité) — la politique de confidentialité les annonce tous, mais aucun automatisme (export JSON en self-service, suppression de compte) n'a été confirmé dans le code lors de cet audit ; à vérifier ou à construire.
6. Revoir ce registre **à chaque nouvelle fonctionnalité** traitant une nouvelle catégorie de données ou un nouveau sous-traitant.
