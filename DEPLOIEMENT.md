# Livraisanté — Guide de déploiement multi-plateformes

## 1. Site web (déjà en production)

**URL actuelle :** https://rayansaidomar1-arch.github.io/livraisante/

Landing page marketing : `livraisante.fr/landing.html`
Application principale : `livraisante.fr/index.html`

Pour migrer vers un domaine personnalisé :
1. Acheter le domaine sur OVH / Gandi
2. GitHub → Settings → Pages → Custom domain : `livraisante.fr`
3. DNS : CNAME → `rayansaidomar1-arch.github.io`
4. Activer "Enforce HTTPS"

---

## 2. Application Android (Google Play)

### Méthode PWABuilder (30 min, recommandée)
1. Aller sur **https://pwabuilder.com**
2. Coller l'URL du site
3. Package for stores → Android → Télécharger l'AAB signé
4. **Récupérer le SHA-256 fingerprint** et l'insérer dans `.well-known/assetlinks.json`
5. Redéployer le site

### Google Play Console
- Compte : 25 € one-time
- Catégorie : Santé et forme
- Icônes : `icons/icon-512.png` (512×512) + `icons/icon-512-maskable.png`
- Révision : 2–7 jours

### Méthode Bubblewrap CLI
```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest=https://livraisante.fr/manifest.json
bubblewrap build
```
Le fichier `twa-manifest.json` est déjà configuré avec le package `fr.livraisante.app`.

---

## 3. Application iOS (App Store)

**Prérequis :** Mac + Xcode 14+ + Apple Developer (99 €/an)

### Méthode Capacitor
```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap add ios
npx cap copy ios
npx cap open ios   # ouvre Xcode
```
Le fichier `capacitor.config.json` est déjà configuré.

Dans Xcode : Signing → Archive → Distribute → App Store Connect

### App Store Connect
- Bundle ID : `fr.livraisante.app`
- Catégorie : Santé et forme
- Screenshots requis : iPhone 6.7" et iPad Pro 12.9"
- Révision : 1–7 jours

---

## 4. Checklist pré-lancement

### Légal (données de santé = art. 9 RGPD)
_Mise à jour 2026-07-22 : cette checklist datait d'avant l'implémentation du modal RGPD_
_(`showRgpdModal()`, index.html) — vérifié directement dans le code, pas seulement supposé :_
- [x] Mentions légales (SIREN, siège, hébergeur) — `showRgpdModal('mentions')` : Livraisanté SAS,
      RCS 933 484 917 Lyon, 1 Rue des Vergers 69120 Vaulx-en-Velin, hébergeur GitHub Pages + Supabase (AWS eu-west-3)
- [x] Politique de confidentialité RGPD — `showRgpdModal('intro')` : base légale, durées de conservation,
      droits Art. 15-22, consentement granulaire Art. 9 dédié à l'inscription (case à cocher séparée des CGU)
- [~] Contact protection des données — **correction du 2026-07-22** : le site affichait `dpo@livraisante.fr`
      comme contact « DPO », mais aucun DPO n'est réellement désigné et cette adresse n'existait pas
      (signalé par le dirigeant). Corrigé dans `index.html` (4 occurrences) : libellé changé en « Contact
      protection des données » (un DPO formel n'est pas obligatoire à ce stade, cf. Art. 37 RGPD) et adresse
      changée en `administratif@livraisante.fr`. **Reste à faire hors code :** activer réellement cette adresse
      (redirection email depuis le panneau OVH/Gandi du domaine `livraisante.fr`) — voir
      `RGPD_REGISTRE_TRAITEMENTS.md` pour le détail
- [x] Registre des traitements CNIL — **fait le 2026-07-22** : `RGPD_REGISTRE_TRAITEMENTS.md` (11 fiches de
      traitement, sous-traitants, durées de conservation), rédigé à partir du schéma Supabase réel et de la
      politique de confidentialité publiée ; à relire et tenir à jour par vous (responsable de traitement),
      voir l'avertissement en tête du document
- [x] Validation contenu par pharmacien diplômé — confirmé le 2026-07-22 par le dirigeant, pharmacien diplômé,
      qui valide personnellement le contenu de conseil (catalogue produits, triage par symptôme, posologies)

### Technique
- [x] Remplacer localStorage par une vraie BDD — fait (Supabase Postgres + RLS, voir `supabase/migrations/`)
- [x] Authentification sécurisée — fait (Supabase Auth)
- [ ] API Annuaire Santé CNAM pour validation FINESS/RPPS réels — toujours un simple contrôle de format
      (`verifyRPPS()`), pas une vérification contre le registre officiel
- [x] Catalogue produit faisant autorité pour les prix côté serveur — fait le 2026-07-22 (table `products`,
      utilisée par `create-payment-intent` pour recalculer le montant exact, cf. plus bas) ; reste toutefois
      une copie du catalogue interne du site, pas un import du catalogue officiel COS/GERS
- [~] Paiements Stripe — fait pour les commandes patients (clés **live**, montant recalculé serveur depuis
      le 2026-07-22) ; les abonnements récurrents pharmacie/patient ne sont pas encore un vrai flux Stripe
      Billing (à vérifier si ce modèle est toujours souhaité)

### Sécurité paiement (ajouté 2026-07-22)
- [x] Montant Stripe recalculé côté serveur depuis le catalogue produit (`products`) — corrige une faille
      documentée où le montant facturé provenait du navigateur (voir
      `supabase/migrations/20260722020000_products_catalog_and_payment_integrity.sql` et
      `supabase/functions/create-payment-intent/index.ts`)
- [ ] Distance de livraison toujours déclarée par le client (impact borné à 6,90 € max par commande,
      contre un montant total auparavant illimité) — un calcul serveur de la distance réelle
      (géocodage adresse ↔ pharmacie) fermerait ce dernier écart
- [ ] Déploiement réel des Edge Functions sur le projet Supabase de production non vérifiable depuis cet
      environnement (pas d'accès CLI/API management ici) — à vérifier vous-même dans le dashboard Supabase
      (Edge Functions → secrets `STRIPE_SECRET_KEY`, `SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` bien définis,
      fonction bien redéployée après la modification du 2026-07-22)

#### Comment déployer `create-payment-intent` (2026-07-22)

⚠️ **`supabase functions deploy ...` est une commande de TERMINAL (CLI), pas du SQL.** Elle ne
fonctionne pas collée dans le SQL Editor du dashboard Supabase (qui n'exécute que du SQL) — c'est
la cause de l'erreur obtenue en la collant là-bas. Il faut l'exécuter dans un vrai terminal
(Terminal.app sur Mac, PowerShell/CMD sur Windows), avec Node.js déjà installé :

```bash
# 1. Installer la CLI Supabase (une seule fois)
npm install -g supabase

# 2. Se connecter (ouvre une page web pour autoriser l'accès à votre compte Supabase)
supabase login

# 3. Lier ce dossier de code au projet Supabase de production
#    (project ref déjà identifié depuis js/config.js : gsmrgafclxkuqzzhtapi)
cd /chemin/vers/livraisante-officiel
supabase link --project-ref gsmrgafclxkuqzzhtapi

# 4. Vérifier/poser les secrets nécessaires à la fonction (si pas déjà fait)
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set SERVICE_ROLE_KEY=...      # trouvable dans Dashboard → Settings → API
# SUPABASE_URL et SUPABASE_ANON_KEY sont auto-injectées par Supabase, pas besoin de les poser

# 5. Déployer la fonction corrigée
supabase functions deploy create-payment-intent
```

Sans cette étape, le fichier `supabase/functions/create-payment-intent/index.ts` corrigé dans ce
dépôt (recalcul serveur du montant) reste seulement du code source local — le correctif n'est
**pas encore actif en production** tant que `supabase functions deploy` n'a pas été exécuté avec
succès depuis un terminal.

---

## 5. Comptes démo

| Rôle | Email | Mot de passe |
|------|-------|-------------|
| 💊 Pharmacie 115 — Grenoble | `pharmacie.demo@livraisante.fr` | `Demo2024!` |
| 🛵 Livreur Jean-Marc Dupont | `livreur.demo@livraisante.fr` | `Demo2024!` |
| 🩺 Patient Marie (enceinte + Lévothyrox) | `patient.demo@livraisante.fr` | `Demo2024!` |

---
*Livraisanté — Juin 2026*
