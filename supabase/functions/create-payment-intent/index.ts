// Supabase Edge Function — create-payment-intent
// Deploy: supabase functions deploy create-payment-intent
// Required env vars:
//   STRIPE_SECRET_KEY   — sk_live_... (set via: supabase secrets set STRIPE_SECRET_KEY=sk_live_...)
//   SUPABASE_URL        — auto-injected by Supabase
//   SUPABASE_ANON_KEY   — auto-injected by Supabase (ou fourni manuellement)
//   SERVICE_ROLE_KEY    — set via Supabase dashboard (SUPABASE_ prefix est réservé)
import Stripe from 'npm:stripe@14.21.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders={
  'Access-Control-Allow-Origin':'https://www.livraisante.fr',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
};

// ── Correctif définitif (2026-07-22) — calcul serveur exact du montant ──────
// Avant ce correctif, le montant Stripe provenait directement du navigateur,
// avec pour seul garde-fou une fourchette de prix heuristique (cf. commentaire
// historique : "Cela ne remplace pas un calcul exact"). Un attaquant pouvait
// obtenir un vrai PaymentIntent pour un montant arbitraire — confirmé
// exploitable en prod (ex: sbCreatePaymentIntent(50,{}) → PaymentIntent de
// 0,50€ quel que soit le panier réel).
//
// Désormais, le client n'envoie plus jamais de montant : il envoie la liste
// des articles (laboratoire + nom, sans prix), le mode de livraison, et une
// distance. Le montant exact est recalculé ici à partir de la table
// `products` (catalogue faisant autorité côté serveur, cf. migration
// 20260722020000_products_catalog_and_payment_integrity.sql) — le client ne
// peut plus influencer le prix des produits ni le sous-total.
//
// Seule zone de confiance résiduelle : la distance de livraison (`distanceKm`)
// reste déclarée par le client (pas de géocodage serveur de l'adresse). Elle
// est bornée (0–500km) et ne peut faire varier le tarif que dans la fourchette
// documentée de DELIVERY_TIERS (3,00€ à 9,90€, écart max 6,90€) — sans commune
// mesure avec la faille précédente (montant total totalement arbitraire).
//
// ── Correctif audit 2026-08-05 (Important #4) ────────────────────────────
// La tarification pharmacien (mode éco/standard/premium + ajustements ±% par
// catégorie, cf. renderPharmaPricingPanel() dans index.html) était purement
// cosmétique : enregistrée uniquement dans le localStorage du navigateur du
// pharmacien (`lv_pharma_pricing`), jamais synchronisée, et ce calcul serveur
// l'ignorait totalement — chaque produit était toujours facturé à son
// `products.prix` de référence, quel que soit le réglage affiché au
// pharmacien. Désormais, ce réglage est stocké dans `pharmacies.extra_settings
// .pricing` (voir pharmacyJsToRow/pharmacyRowToJs dans js/supabase-client.js)
// et réellement appliqué ici : le multiplicateur du mode choisi, ou l'override
// par catégorie s'il existe, est appliqué au prix catalogue de chaque article
// avant de calculer le sous-total.
const PRICING_MODES: Record<string, number> = { eco:0.85, std:1.00, prem:1.15 };
const MARGE_PCT=0.10;         // marge Livraisanté sur les produits (cf. MARGE_PCT index.html)
const COMMISSION_PCT=0.05;    // frais de fonctionnement (cf. PLATFORM_FEE_RATE index.html)
// Aucun forfait de repli : une commande `livraison` sans distance exploitable est
// refusée (400) plutôt que facturée à un tarif arbitraire — cf. getDeliveryFee()
// et placeOrderSante() dans index.html, et l'article 4 des CGV patient.
const DELIVERY_TIERS=[        // cf. DELIVERY_TIERS index.html — doit rester synchronisé
  {maxKm:2,        price:3.00},
  {maxKm:4,        price:4.50},
  {maxKm:20,       price:6.90},
  {maxKm:Infinity, price:9.90},
];
const MAX_ITEMS=30;           // taille de panier raisonnable
const MAX_DISTANCE_KM=500;    // borne de cohérence sur la distance déclarée

/** @returns frais en euros, ou `null` si la distance est inexploitable (mode livraison). */
function deliveryFeeEur(mode: string, distanceKm: unknown): number|null{
  if(mode==='cnc'||mode==='cnc_club') return 0;
  const d=(typeof distanceKm==='number' && isFinite(distanceKm) && distanceKm>=0)
    ? Math.min(distanceKm, MAX_DISTANCE_KM) : null;
  if(d===null) return null; // distance inconnue → tarif indéterminable
  const tier=DELIVERY_TIERS.find(t=>d<=t.maxKm);
  return tier?tier.price:9.90;
}

function donationAmountEur(rawTotal: number): number{
  // cf. donationAmount() index.html : arrondir à 2 décimales AVANT de prendre la
  // part décimale, sinon un sous-total comme 12.999000000000002 donne un don nul.
  const cents=Math.round((Math.round(rawTotal*100)/100)%1*100)/100;
  return cents===0 ? 1.00 : parseFloat((1-cents).toFixed(2));
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders});
  try{
    // ── Correctif audit 2026-09-21 (Critique, faille 2) ──────────────────────
    // `currency` était lu du corps de la requête (`currency='eur'` n'était qu'un
    // défaut, pas une contrainte) et transmis tel quel à Stripe. Or `finalAmount`
    // est calculé en CENTIMES D'EURO. En passant une devise à zéro décimale
    // (`jpy`, `krw`, `vnd`...), `amount:1000` ne vaut plus 10,00 € mais 1000 yens
    // (~5,80 €) : le patient était débité d'une fraction du prix, tandis que
    // `confirm-order` enregistrait `pi.amount/100 = 10,00 €` en base et créditait
    // la cagnotte club sur cette base — donc sur de l'argent jamais encaissé.
    // La devise n'est plus lue du client : ce service ne facture qu'en euros.
    const {items,deliveryMode,distanceKm,donationEnabled,metadata={},pharmacyId}=await req.json();
    const currency='eur';

    if(!Array.isArray(items)||items.length===0||items.length>MAX_ITEMS){
      return new Response(JSON.stringify({error:'Panier invalide'}),{status:400,headers:corsHeaders});
    }
    if(!['livraison','cnc','cnc_club'].includes(deliveryMode)){
      return new Response(JSON.stringify({error:'Mode de livraison invalide'}),{status:400,headers:corsHeaders});
    }
    if(!pharmacyId||typeof pharmacyId!=='string'){
      return new Response(JSON.stringify({error:'pharmacyId manquant'}),{status:400,headers:corsHeaders});
    }

    const supabaseUrl=Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey=Deno.env.get('SERVICE_ROLE_KEY')!;
    const supabase=createClient(supabaseUrl,serviceRoleKey);

    // Authentification obligatoire — on doit savoir qui paie avant de créer un PaymentIntent.
    const authHeader=req.headers.get('Authorization');
    let userId: string|null=null;
    if(authHeader){
      const anonKey=Deno.env.get('SUPABASE_ANON_KEY')||serviceRoleKey;
      const anonClient=createClient(supabaseUrl,anonKey);
      const {data:{user}}=await anonClient.auth.getUser(authHeader.replace('Bearer ',''));
      userId=user?.id||null;
    }
    if(!userId){
      return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:corsHeaders});
    }

    // ── Rate-limiting (audit 2026-07-23, Moyen) — un vrai PaymentIntent Stripe
    // est créé à chaque appel (coût/quota Stripe réel) ; on borne le nombre de
    // créations par utilisateur pour éviter qu'un bug client en boucle ou un
    // abus ne génère un volume anormal. Échec de l'appel RPC = fail-open (le
    // rate-limiting est une protection en profondeur, pas la barrière
    // principale — ne doit pas empêcher un vrai paiement en cas de souci infra).
    try{
      const {data:allowed,error:rlErr}=await supabase.rpc('check_rate_limit',{
        p_bucket:`create-payment-intent:${userId}`, p_max_hits:20, p_window_seconds:600,
      });
      if(!rlErr && allowed===false){
        return new Response(JSON.stringify({error:'Trop de tentatives de paiement, réessayez dans quelques minutes.'}),{status:429,headers:corsHeaders});
      }
    }catch(_e){ /* fail-open volontaire, voir commentaire ci-dessus */ }

    // Tarification pharmacien (mode + overrides par catégorie) — cf. commentaire
    // Important #4 en tête de fichier. Défaut neutre (mode standard, aucun
    // override) si la pharmacie n'a jamais configuré de tarification.
    const {data:pharmacyRow}=await supabase
      .from('pharmacies').select('extra_settings').eq('id',pharmacyId).maybeSingle();
    const pricingCfg=pharmacyRow?.extra_settings?.pricing||{};
    const pricingMode=PRICING_MODES[pricingCfg.mode]!==undefined?pricingCfg.mode:'std';
    const overrides=(pricingCfg.overrides&&typeof pricingCfg.overrides==='object')?pricingCfg.overrides:{};
    function priceMultiplier(category: string|null): number{
      const raw=(category&&overrides[category]!==undefined)?Number(overrides[category]):PRICING_MODES[pricingMode];
      if(!isFinite(raw)) return PRICING_MODES[pricingMode];
      return Math.max(0.50,Math.min(2.00,raw)); // même borne que adjustOverride() côté client
    }

    // Recalcul exact du sous-total à partir du catalogue serveur (`products`) —
    // jamais depuis un prix fourni par le client — puis application du
    // positionnement tarifaire choisi par la pharmacie.
    let base=0;
    // `canonicalItems` est le panier RÉELLEMENT facturé : chaque entrée a été
    // résolue contre le catalogue `products`. C'est lui qui sera enregistré plus
    // bas dans `payment_carts` puis relu par `confirm-order` — cf. correctif
    // faille 1 ci-dessous.
    const canonicalItems: {lab:string;name:string}[]=[];
    for(const it of items){
      const lab=String(it?.lab||'').trim();
      const name=String(it?.name||'').trim();
      if(!lab||!name){
        return new Response(JSON.stringify({error:'Article invalide'}),{status:400,headers:corsHeaders});
      }
      const {data:prod,error:prodErr}=await supabase
        .from('products').select('prix,active,category')
        .eq('lab',lab).eq('name',name).maybeSingle();
      if(prodErr||!prod||prod.active===false){
        return new Response(JSON.stringify({error:`Produit introuvable : ${name} (${lab})`}),{status:400,headers:corsHeaders});
      }
      base+=Number(prod.prix)*priceMultiplier(prod.category);
      canonicalItems.push({lab,name});
    }

    const subtotal=base*(1+MARGE_PCT);
    const feeEur=deliveryFeeEur(deliveryMode,distanceKm);
    if(feeEur===null){
      // Livraison sans distance exploitable : refus explicite. Le front bloque déjà
      // ce cas (placeOrderSante), ce garde-fou couvre les appels directs à l'API.
      return new Response(JSON.stringify({error:'Distance de livraison manquante ou invalide : les frais de livraison ne peuvent pas être calculés.'}),{status:400,headers:corsHeaders});
    }
    const raw=deliveryMode==='cnc' ? subtotal : subtotal+feeEur; // cf. cartTotal() index.html
    const commission=raw*COMMISSION_PCT;
    const donation=donationEnabled ? donationAmountEur(raw) : 0;
    const totalEur=Math.round((raw+commission+donation)*100)/100;
    const finalAmount=Math.round(totalEur*100);

    if(finalAmount<50) return new Response(JSON.stringify({error:'Montant minimum 0.50€'}),{status:400,headers:corsHeaders});

    const finalDeliveryFeeEur=deliveryMode==='cnc'?0:feeEur;

    const stripe=new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!,{apiVersion:'2024-06-20'});
    const paymentIntent=await stripe.paymentIntents.create({
      amount:finalAmount, currency,
      automatic_payment_methods:{enabled:true},
      // deliveryFeeCents est posé ici (calculé serveur, jamais par le client) afin que
      // `confirm-order` puisse relire une part de tarification faisant autorité au moment
      // de créer la commande, sans jamais avoir à refaire confiance à une valeur envoyée
      // par le client à ce moment-là (cf. migration 20260722030000 + confirm-order/index.ts).
      // `commissionCents` suit la même logique que `deliveryFeeCents` : la cagnotte
      // club se calcule sur les frais RÉELLEMENT prélevés, pas sur `pi.amount`, qui
      // contient en plus la commission elle-même et l'arrondi du don solidaire. La
      // recalculer depuis le total créditerait au club davantage que l'encaissé —
      // un déficit net maintenant que la totalité des frais lui revient.
      metadata:{...metadata,platform:'livraisante',userId,deliveryFeeCents:String(Math.round(finalDeliveryFeeEur*100)),commissionCents:String(Math.round(commission*100))},
    });

    // ── Correctif audit 2026-09-21 (Critique, faille 1) ──────────────────────
    // On enregistre le panier canonique qui vient de servir au calcul du montant,
    // lié au PaymentIntent. `confirm-order` le relira ici au lieu de faire
    // confiance aux `items` du corps de sa propre requête : sans cela, le montant
    // était bien vérifié mais portait sur un panier que plus rien ne rattachait à
    // celui finalement enregistré en commande.
    // Bloquant volontairement : si le panier ne peut pas être enregistré, le
    // PaymentIntent ne doit pas être remis au client, sinon `confirm-order`
    // refusera la commande APRÈS que le patient aura été débité.
    const {error:cartErr}=await supabase.from('payment_carts').insert({
      payment_intent_id: paymentIntent.id,
      user_id: userId,
      pharmacy_id: pharmacyId,
      delivery_mode: deliveryMode,
      items: canonicalItems,
      amount_cents: finalAmount,
    });
    if(cartErr){
      console.error('create-payment-intent payment_carts insert error',cartErr);
      // Le PaymentIntent créé juste au-dessus n'a encore débité personne
      // (status 'requires_payment_method') : on l'annule pour ne pas laisser
      // d'intention de paiement orpheline côté Stripe.
      try{ await stripe.paymentIntents.cancel(paymentIntent.id); }
      catch(cancelErr){ console.error('create-payment-intent cancel après échec panier',cancelErr); }
      return new Response(JSON.stringify({error:"Impossible d'initialiser le paiement. Réessayez dans un instant."}),{status:500,headers:corsHeaders});
    }

    return new Response(JSON.stringify({
      clientSecret:paymentIntent.client_secret,
      paymentIntentId:paymentIntent.id,
      amountEur:totalEur,
      deliveryFeeEur:finalDeliveryFeeEur,
    }),{
      headers:{...corsHeaders,'Content-Type':'application/json'}
    });
  }catch(err){
    return new Response(JSON.stringify({error:err.message}),{status:500,headers:corsHeaders});
  }
});
