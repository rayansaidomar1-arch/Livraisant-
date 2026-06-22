# Configuration Stripe — Livraisanté

## 1. Clé publique (front-end)

Dans `index.html`, remplacer la valeur de `STRIPE_PUBLISHABLE_KEY` par votre clé publique trouvée sur [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys) :

```js
const STRIPE_PUBLISHABLE_KEY = 'pk_live_VOTRE_CLE_ICI';
```

## 2. Déployer la Edge Function Supabase

```bash
# Depuis la racine du projet
supabase functions deploy create-payment-intent

# Configurer la clé secrète Stripe (ne jamais la committer)
supabase secrets set STRIPE_SECRET_KEY=sk_live_VOTRE_CLE_SECRETE_ICI
```

## 3. Vérifier dans le Dashboard Supabase

- Aller dans **Edge Functions** → `create-payment-intent` → vérifier que le déploiement est actif
- Aller dans **Settings** → **Secrets** → vérifier que `STRIPE_SECRET_KEY` est présent

## 4. Test en mode démo

Tant que `STRIPE_PUBLISHABLE_KEY` contient `VOTRE_CLE`, le paiement est simulé automatiquement (mode démo — aucune transaction réelle).

## 5. Clés de test Stripe

Pour tester sans facturation réelle, utiliser les clés `pk_test_...` / `sk_test_...` depuis le dashboard Stripe (mode Test).

---

Pour toute question : contact@livraisante.fr
