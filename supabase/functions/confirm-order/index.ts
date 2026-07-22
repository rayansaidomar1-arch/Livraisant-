// Supabase Edge Function — confirm-order
// Deploy: supabase functions deploy confirm-order
// Required env vars (identiques à create-payment-intent) :
//   STRIPE_SECRET_KEY   — sk_live_...
//   SUPABASE_URL        — auto-injecté par Supabase
//   SUPABASE_ANON_KEY   — auto-injecté par Supabase (utilisé pour vérifier le JWT patient)
//   SERVICE_ROLE_KEY    — Dashboard → Settings → API (nécessaire pour contourner RLS à l'insertion)
//
// ── Correctif audit sécurité 2026-07-22 (Critique #2) ───────────────────────
// Avant ce correctif, un patient authentifié pouvait appeler directement
// `sb.from('orders').insert(...)` (exposé côté client via `sbInsertOrderFull`)
// avec un `pricing.totalEur` entièrement fabriqué, sans jamais passer par
// Stripe. Cette valeur alimentait ensuite les stats admin, les factures
// pharmacie/livreur et l'export CSV.
//
// Désormais, pour toute commande PAYANTE (santé / click-collect / cnc-club) :
// - la policy RLS `orders_patient_insert` (migration 20260722030000) interdit
//   à un patient de poser lui-même un `pricing.totalEur` non nul par insert direct ;
// - seule cette fonction peut créer une telle commande, et seulement après avoir
//   vérifié ICI, côté serveur, avec la clé secrète Stripe :
//     1. que le PaymentIntent fourni par le client existe réellement,
//     2. qu'il a le statut 'succeeded' (donc réellement débité),
//     3. qu'il appartient bien à l'utilisateur authentifié faisant l'appel
//        (comparaison à `pi.metadata.userId`, posé par create-payment-intent),
//     4. qu'il n'a pas déjà servi à créer une autre commande (idempotence).
// Le montant inséré en base (`pricing.totalEur`/`deliveryFeeEur`) provient
// exclusivement de `pi.amount` et de `pi.metadata.deliveryFeeCents` — jamais
// d'une valeur envoyée par le client dans le corps de la requête.
//
// Les commandes GRATUITES (kind='sportif', inscriptions à un événement club)
// ne passent pas par cette fonction : elles restent insérées directement par
// le patient via `sbInsertOrderFull`, avec `pricing.totalEur` toujours NULL.
import Stripe from 'npm:stripe@14.21.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders={
  'Access-Control-Allow-Origin':'https://www.livraisante.fr',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
};

const ALLOWED_KINDS=['santé','click-collect','cnc-club'];
const DELIVERY_MODE_BY_KIND: Record<string,string>={ 'santé':'livraison', 'click-collect':'cnc', 'cnc-club':'cnc_club' };
const MAX_ITEMS=30;

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders});
  try{
    const body=await req.json();
    const { paymentIntentId, id, code, kind, pharmacyId, patient, items }=body||{};

    if(typeof paymentIntentId!=='string'||!paymentIntentId.startsWith('pi_')){
      return new Response(JSON.stringify({error:'paymentIntentId invalide'}),{status:400,headers:corsHeaders});
    }
    if(typeof id!=='string'||!id){
      return new Response(JSON.stringify({error:'id invalide'}),{status:400,headers:corsHeaders});
    }
    if(!ALLOWED_KINDS.includes(kind)){
      return new Response(JSON.stringify({error:'kind invalide'}),{status:400,headers:corsHeaders});
    }
    if(!pharmacyId||typeof pharmacyId!=='string'){
      return new Response(JSON.stringify({error:'pharmacyId manquant'}),{status:400,headers:corsHeaders});
    }
    if(!Array.isArray(items)||items.length===0||items.length>MAX_ITEMS){
      return new Response(JSON.stringify({error:'Panier invalide'}),{status:400,headers:corsHeaders});
    }

    const supabaseUrl=Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey=Deno.env.get('SERVICE_ROLE_KEY')!;
    const supabaseAdmin=createClient(supabaseUrl,serviceRoleKey);

    // Authentification obligatoire — on doit savoir qui confirme la commande.
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

    // ── Coeur du correctif : on ne fait confiance à AUCUN montant envoyé par le
    // client. On relit le PaymentIntent réellement créé par create-payment-intent
    // (montant calculé côté serveur à partir du catalogue `products`) directement
    // auprès de Stripe, avec la clé secrète. ──
    const stripe=new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!,{apiVersion:'2024-06-20'});
    let pi;
    try{
      pi=await stripe.paymentIntents.retrieve(paymentIntentId);
    }catch(_e){
      return new Response(JSON.stringify({error:'PaymentIntent introuvable'}),{status:400,headers:corsHeaders});
    }
    if(pi.status!=='succeeded'){
      return new Response(JSON.stringify({error:'Paiement non confirmé'}),{status:400,headers:corsHeaders});
    }
    if(pi.metadata?.userId!==userId){
      return new Response(JSON.stringify({error:"Ce paiement n'appartient pas à cet utilisateur"}),{status:403,headers:corsHeaders});
    }

    // Idempotence : un même PaymentIntent ne doit créer qu'une seule commande
    // (double-clic, retry réseau côté client...). Si une commande existe déjà
    // pour ce paiement, on la renvoie telle quelle plutôt que d'en recréer une.
    const {data:existingOrder}=await supabaseAdmin
      .from('orders').select('*')
      .eq('payment->>paymentIntentId', paymentIntentId)
      .maybeSingle();
    if(existingOrder){
      return new Response(JSON.stringify({order:existingOrder}),{
        headers:{...corsHeaders,'Content-Type':'application/json'}
      });
    }

    const totalEur=pi.amount/100;
    const deliveryFeeCents=Number(pi.metadata?.deliveryFeeCents||0);
    const deliveryFeeEur=deliveryFeeCents/100;

    const row={
      id, code: code||null, kind,
      patient_id: userId,
      pharmacy_id: pharmacyId,
      status: 'nouvelle',
      items,
      delivery_mode: DELIVERY_MODE_BY_KIND[kind]||'livraison',
      patient_name: patient?.name||null,
      patient_address: patient?.addr||null,
      patient_pos: patient?.pos||null,
      pricing: { totalEur, deliveryFeeEur },
      payment: { email: patient?.email||'', donation: patient?.donation||null, paymentIntentId },
    };
    const {data,error}=await supabaseAdmin.from('orders').insert(row).select().single();
    if(error){
      return new Response(JSON.stringify({error:error.message}),{status:500,headers:corsHeaders});
    }
    return new Response(JSON.stringify({order:data}),{
      headers:{...corsHeaders,'Content-Type':'application/json'}
    });
  }catch(err){
    return new Response(JSON.stringify({error:err.message}),{status:500,headers:corsHeaders});
  }
});
