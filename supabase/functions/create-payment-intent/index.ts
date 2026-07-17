// Supabase Edge Function — create-payment-intent
// Deploy: supabase functions deploy create-payment-intent
// Required env vars:
//   STRIPE_SECRET_KEY   — sk_live_... (set via: supabase secrets set STRIPE_SECRET_KEY=sk_live_...)
//   SUPABASE_URL        — auto-injected by Supabase
//   SERVICE_ROLE_KEY    — set via Supabase dashboard (SUPABASE_ prefix is reserved)
import Stripe from 'npm:stripe@14.21.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders={
  'Access-Control-Allow-Origin':'https://www.livraisante.fr',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
};

// ── Correctif rapide (2026-07-13) — garde-fou anti-montant-falsifié ──────
// Tant que le flux commandes santé n'envoie pas d'orderId (calcul serveur exact,
// cf. branche ci-dessous), on ne peut pas faire confiance à `amount` fourni par
// le client (un attaquant peut appeler sbCreatePaymentIntent(50, {}) depuis la
// console pour créer un vrai PaymentIntent Stripe de 0,50€ quel que soit le
// panier réel — confirmé exploitable en prod). En attendant la migration
// complète (recalcul exact du panier côté serveur), on borne le montant à une
// fourchette réaliste dérivée du vrai catalogue produit (PRODUCT_CATALOG,
// index.html) et du nombre d'articles déclaré (metadata.itemCount).
// Cela ne remplace pas un calcul exact, mais rend inefficace l'attaque
// "montant arbitraire" démontrée lors de l'audit de sécurité.
const MIN_UNIT_PRICE=3.90;   // prix produit le plus bas observé dans PRODUCT_CATALOG
const MAX_UNIT_PRICE=34.90;  // prix produit le plus haut observé dans PRODUCT_CATALOG
const MARGE_PCT=0.10;        // marge Livraisanté sur les produits (cf. MARGE_PCT index.html)
const COMMISSION_PCT=0.10;   // frais de fonctionnement (cf. platformCommission index.html)
const MAX_DELIVERY_FEE=9.90; // tarif livraison le plus élevé (DELIVERY_TIERS index.html)
const MAX_DONATION=1.00;     // arrondi don association/club (donationAmount index.html)
const MAX_ITEMS=30;          // taille de panier raisonnable
const TOLERANCE_EUR=0.02;    // marge d'arrondi flottant

function priceRangeEur(itemCount: number){
  const cartMin=itemCount*MIN_UNIT_PRICE*(1+MARGE_PCT);
  const cartMax=itemCount*MAX_UNIT_PRICE*(1+MARGE_PCT)+MAX_DELIVERY_FEE;
  const totalMin=cartMin*(1+COMMISSION_PCT);
  const totalMax=cartMax*(1+COMMISSION_PCT)+MAX_DONATION;
  return {totalMin,totalMax};
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders});
  try{
    const {amount,orderId,currency='eur',metadata={}}=await req.json();

    let finalAmount: number;

    if(orderId){
      // Montant calculé côté serveur depuis la table orders — l'utilisateur ne peut pas le falsifier
      const supabaseUrl=Deno.env.get('SUPABASE_URL')!;
      const serviceRoleKey=Deno.env.get('SERVICE_ROLE_KEY')!;
      const supabase=createClient(supabaseUrl,serviceRoleKey);

      // Récupère l'utilisateur authentifié depuis le JWT du header Authorization
      const authHeader=req.headers.get('Authorization');
      let userId: string|null=null;
      if(authHeader){
        const anonKey=Deno.env.get('SUPABASE_ANON_KEY')||serviceRoleKey;
        const anonClient=createClient(supabaseUrl,anonKey);
        const {data:{user}}=await anonClient.auth.getUser(authHeader.replace('Bearer ',''));
        userId=user?.id||null;
      }

      const {data:order,error:orderErr}=await supabase
        .from('orders')
        .select('amount_cents,patient_id')
        .eq('id',orderId)
        .single();

      if(orderErr||!order){
        return new Response(JSON.stringify({error:'Order not found'}),{status:403,headers:corsHeaders});
      }
      // L'authentification est obligatoire quand un orderId est fourni
      if(!userId){
        return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:corsHeaders});
      }
      // Vérifie que la commande appartient bien à l'utilisateur authentifié
      if(order.patient_id!==userId){
        return new Response(JSON.stringify({error:'Forbidden'}),{status:403,headers:corsHeaders});
      }
      finalAmount=Math.round(order.amount_cents);
    } else {
      // Fallback : montant fourni par le client, mais désormais validé contre une
      // fourchette de cohérence dérivée du panier réel (voir garde-fou ci-dessus).
      // Ne remplace pas le calcul exact (branche orderId) mais bloque toute
      // tentative de montant fantaisiste (ex: 0,50€ pour un vrai panier).
      if(!amount||amount<50) return new Response(JSON.stringify({error:'Montant minimum 0.50€'}),{status:400,headers:corsHeaders});

      const itemCount=Number(metadata?.itemCount);
      if(!Number.isInteger(itemCount)||itemCount<1||itemCount>MAX_ITEMS){
        return new Response(JSON.stringify({error:'Panier invalide'}),{status:400,headers:corsHeaders});
      }

      const amountEur=amount/100;
      const {totalMin,totalMax}=priceRangeEur(itemCount);
      if(amountEur<totalMin-TOLERANCE_EUR||amountEur>totalMax+TOLERANCE_EUR){
        console.warn('create-payment-intent: montant hors fourchette attendue',{amountEur,itemCount,totalMin,totalMax});
        return new Response(JSON.stringify({error:'Montant incohérent avec le panier'}),{status:400,headers:corsHeaders});
      }
      finalAmount=Math.round(amount);
    }

    if(finalAmount<50) return new Response(JSON.stringify({error:'Montant minimum 0.50€'}),{status:400,headers:corsHeaders});

    const stripe=new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!,{apiVersion:'2024-06-20'});
    const paymentIntent=await stripe.paymentIntents.create({
      amount:finalAmount, currency,
      automatic_payment_methods:{enabled:true},
      metadata:{...metadata,...(orderId?{orderId}:{}),platform:'livraisante'},
    });
    return new Response(JSON.stringify({clientSecret:paymentIntent.client_secret}),{
      headers:{...corsHeaders,'Content-Type':'application/json'}
    });
  }catch(err){
    return new Response(JSON.stringify({error:err.message}),{status:500,headers:corsHeaders});
  }
});
