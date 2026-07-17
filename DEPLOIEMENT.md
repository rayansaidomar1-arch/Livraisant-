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
- [ ] Mentions légales (SIREN, siège, hébergeur)
- [ ] Politique de confidentialité RGPD
- [ ] DPO désigné obligatoire (données de santé sensibles)
- [ ] Registre des traitements CNIL
- [ ] Validation contenu par pharmacien diplômé

### Technique
- [ ] Remplacer localStorage par une vraie BDD (Supabase / Firebase)
- [ ] Authentification sécurisée (Firebase Auth / OAuth2)
- [ ] API Annuaire Santé CNAM pour validation FINESS/RPPS réels
- [ ] Catalogue COS officiel pour les produits et prix
- [ ] Paiements Stripe pour les abonnements pharmacies

---

## 5. Comptes démo

| Rôle | Email | Mot de passe |
|------|-------|-------------|
| 💊 Pharmacie 115 — Grenoble | `pharmacie.demo@livraisante.fr` | `Demo2024!` |
| 🛵 Livreur Jean-Marc Dupont | `livreur.demo@livraisante.fr` | `Demo2024!` |
| 🩺 Patient Marie (enceinte + Lévothyrox) | `patient.demo@livraisante.fr` | `Demo2024!` |

---
*Livraisanté — Juin 2026*
