# Double authentification (2FA TOTP) — mise en service

## Où vit la 2FA

Clever Cloud n'héberge pas l'authentification. Depuis la migration hybride du
18/07/2026, **Supabase Auth est l'unique fournisseur d'identité** ; le backend
Express hébergé sur Clever Cloud ne fait que *vérifier* les JWT émis par
Supabase (via JWKS, `backend/src/lib/auth.js`).

La 2FA s'appuie donc sur le MFA natif de Supabase (TOTP), et Clever Cloud
**applique** l'exigence sur les routes de données de santé.

## Choix retenus

| Point | Choix |
|---|---|
| Méthode | TOTP — application d'authentification (Google Authenticator, Authy, gestionnaire de mots de passe) |
| Public | Patients (`patient`, `patient_licencie`) |
| Activation | Optionnelle, depuis le profil |
| Portée une fois activée | Code exigé à chaque connexion + claim `aal2` exigé sur `/auth/health-profile` |

TOTP plutôt que SMS ou email : aucun coût par message, et pas de vecteur
SIM-swap ni d'interception de boîte mail.

## Étape manuelle requise (Dashboard Supabase)

Cette étape ne peut pas être faite depuis le code.

1. Dashboard Supabase → **Authentication** → **Multi-Factor Authentication**
2. Activer **TOTP (App Authenticator)**
3. Laisser « Maximum enrolled factors » à 1 ou plus

Sans cette activation, `sb.auth.mfa.enroll()` renvoie une erreur et le bouton
d'activation du profil affiche « La double authentification n'est pas encore
activée sur ce service. »

## Permission base de données requise

`requireAal2` lit `auth.mfa_factors` via la connexion Postgres directe
(`SUPABASE_DB_URI`, cf. `backend/src/lib/supabaseDb.js`). Le rôle utilisé par
cette chaîne de connexion doit donc avoir `SELECT` sur cette table :

```sql
GRANT USAGE ON SCHEMA auth TO <role_backend>;
GRANT SELECT ON auth.mfa_factors TO <role_backend>;
```

(inutile si `SUPABASE_DB_URI` utilise le rôle `postgres`).

Le middleware **échoue en fermé** : si cette lecture est impossible, les routes
du dossier de santé renvoient 503 plutôt que de servir les données sans
vérification.

## Parcours utilisateur

**Activation** — Profil → « 🔐 Double authentification » → *Activer* → scan du
QR code (ou saisie manuelle de la clé) → saisie du premier code à 6 chiffres.
Tant que ce premier code n'est pas validé, le facteur reste `unverified` et ne
protège rien ; annuler l'écran le supprime. Les facteurs inachevés laissés par
un abandon (onglet fermé) sont purgés automatiquement au réenrôlement suivant —
sinon ils compteraient dans `MAX_ENROLLED_FACTORS` et bloqueraient
définitivement toute activation.

**Connexion** — après le mot de passe, la session est `aal1`. Si le compte a un
facteur vérifié, un écran bloquant réclame le code ; l'annulation referme la
session (`signOut`). La garde `mfaEnforceOrAbort()` est posée sur **tous** les
chemins qui ouvrent une session — mot de passe, OAuth Google, réinitialisation
de mot de passe, et restauration au chargement de page. Ce dernier point est
essentiel : Supabase persiste la session dès la validation du mot de passe, donc
sans garde au rechargement il suffisait d'appuyer sur F5 pendant l'écran de
saisie du code pour entrer avec une session `aal1`.

**Désactivation** — même section, bouton *Désactiver*. Un code TOTP frais est
exigé : retirer la 2FA est aussi sensible que lire les données qu'elle protège,
et sans cela une session volée suffirait à la désactiver.

## ⚠️ Limite actuelle — l'exigence `aal2` ne protège pas encore les données réelles

Le frontend **n'appelle pas encore** le backend Clever Cloud (`js/config.js` n'a
pas d'`api_base`, la migration hybride est en cours). Les données de santé
réellement manipulées aujourd'hui sont écrites par le navigateur dans
`profiles.health_profile` **sur Supabase** (`saveHealthProfile`, `savePhysique`),
lisibles via `sbGetProfile` avec un JWT `aal1`.

Autrement dit : `requireAal2` garde correctement une porte que personne
n'emprunte encore. Tant que la migration n'est pas terminée, la 2FA protège
l'**accès au compte** (ce qui est déjà l'essentiel), mais pas la lecture directe
du dossier de santé par une session `aal1`.

Deux façons de refermer ce trou, à arbitrer :
1. Brancher le front sur `GET`/`PUT /auth/health-profile` (c'est la cible de la
   migration de toute façon) ;
2. Ou, plus rapide, ajouter une policy RLS Supabase exigeant
   `auth.jwt()->>'aal' = 'aal2'` pour lire/écrire `profiles.health_profile`
   lorsqu'un facteur vérifié existe. Attention : à déployer avec précaution,
   une policy trop large verrouillerait les patients sans 2FA.

## Fichiers concernés

| Fichier | Rôle |
|---|---|
| `js/supabase-client.js` | Wrappers `sbMfaListFactors` / `sbMfaEnroll` / `sbMfaVerify` / `sbMfaUnenroll` / `sbMfaGetAal` |
| `index.html` | Section profil (`renderMfaSection`, `patchMfaSection`, `mfaStartEnroll`…) et élévation à la connexion (`mfaStepUpIfNeeded`, `mfaPromptStepUp`) |
| `backend/src/lib/supabaseDb.js` | `hasVerifiedMfaFactor(userId)` |
| `backend/src/lib/auth.js` | Capture du claim `aal`, middleware `requireAal2`, prédicat `needsMfaStepUp` |
| `backend/src/routes/auth.js` | `requireAal2` sur GET/PUT `/auth/health-profile` ; `/auth/me` dégrade (retire `healthProfile`, expose `mfaRequired`) |

## Comportement d'API

- `GET|PUT /auth/health-profile` sans second facteur alors qu'un facteur est
  actif → `403 { error, code: "mfa_required" }`. Le front doit déclencher
  l'élévation sur ce code, pas afficher une erreur générique.
- `GET /auth/me` reste accessible et renvoie `mfaRequired: true` avec
  `healthProfile: null`.
- Un patient **sans** 2FA n'est pas affecté : `requireAal2` laisse passer.
