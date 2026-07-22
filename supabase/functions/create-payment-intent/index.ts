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
const MARGE_PCT=0.10;         // marge Livraisanté sur les produits (cf. MARGE_PCT index.html)
const COMMISSION_PCT=0.10;    // frais de fonctionnement (cf. platformCommission index.html)
const FRAIS_LIVRAISON_FALLBACK=3.90; // cf. FRAIS_LIVRAISON index.html (distance inconnue)
const DELIVERY_TIERS=[        // cf. DELIVERY_TIERS index.html — doit rester synchronisé
  {maxKm:2,        price:3.00},
  {maxKm:4,        price:4.50},
  {maxKm:20,       price:6.90},
  {maxKm:Infinity, price:9.90},
];
const MAX_ITEMS=30;           // taille de panier raisonnable
const MAX_DISTANCE_KM=500;    // borne de cohérence sur la distance déclarée

function deliveryFeeEur(mode: string, distanceKm: unknown): number{
  if(mode==='cnc'||mode==='cnc_club') return 0;
  const d=(typeof distanceKm==='number' && isFinite(distanceKm) && distanceKm>=0)
    ? Math.min(distanceKm, MAX_DISTANCE_KM) : null;
  if(d===null) return FRAIS_LIVRAISON_FALLBACK;
  const tier=DELIVERY_TIERS.find(t=>d<=t.maxKm);
  return tier?tier.price:9.90;
}

function donationAmountEur(rawTotal: number): number{
  const cents=rawTotal%1;
  return cents===0 ? 1.00 : parseFloat((1-cents).toFixed(2));
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders});
  try{
    const {items,deliveryMode,distanceKm,donationEnabled,currency='eur',metadata={}}=await req.json();

    if(!Array.isArray(items)||items.length===0||items.length>MAX_ITEMS){
      return new Response(JSON.stringify({error:'Panier invalide'}),{status:400,headers:corsHeaders});
    }
    if(!['livraison','cnc','cnc_club'].includes(deliveryMode)){
      return new Response(JSON.stringify({error:'Mode de livraison invalide'}),{status:400,headers:corsHeaders});
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

    // Recalcul exact du sous-total à partir du catalogue serveur (`products`) —
    // jamais depuis un prix fourni par le client.
    let base=0;
    for(const it of items){
      const lab=String(it?.lab||'').trim();
      const name=String(it?.name||'').trim();
      if(!lab||!name){
        return new Response(JSON.stringify({error:'Article invalide'}),{status:400,headers:corsHeaders});
      }
      const {data:prod,error:prodErr}=await supabase
        .from('products').select('prix,active')
        .eq('lab',lab).eq('name',name).maybeSingle();
      if(prodErr||!prod||prod.active===false){
        return new Response(JSON.stringify({error:`Produit introuvable : ${name} (${lab})`}),{status:400,headers:corsHeaders});
      }
      base+=Number(prod.prix);
    }

    const subtotal=base*(1+MARGE_PCT);
    const feeEur=deliveryFeeEur(deliveryMode,distanceKm);
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
      metadata:{...metadata,platform:'livraisante',userId,deliveryFeeCents:String(Math.round(finalDeliveryFeeEur*100))},
    });
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
