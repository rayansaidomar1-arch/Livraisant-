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
//
// ── Correctif audit 2026-08-05 (Important #7) ───────────────────────────
// La cagnotte club (frais de fonctionnement Livraisanté, reversés au
// club du patient adhérent) était créditée côté client, dans le
// localStorage du PATIENT (`livraisante_cagnotte_${clubId}`) — jamais vue
// par le club ni par l'admin sur un autre appareil, et créditée AVANT même
// la confirmation réelle du paiement, sur un total non vérifié envoyé par
// le client. Comme pour `pricing.totalEur` plus haut, on ne fait plus
// confiance à rien venant du client : la contribution est désormais
// calculée ICI à partir du PaymentIntent Stripe réellement débité, et
// seulement si le patient appartient à un club où son adhésion est validée
// (`club_members.validated=true` — jamais son propre statut auto-déclaré).
// Best-effort, non bloquant : un club qui n'a pas encore d'entrée `clubs`
// valide ou une erreur d'insertion ne doit jamais faire échouer la commande
// déjà payée.
//
// La base est `metadata.commissionCents`, posée par create-payment-intent, et
// NON `pi.amount` : ce dernier contient le panier, la commission elle-même et
// l'arrondi du don solidaire. Créditer CLUB_SHARE_RATE de `pi.amount` reversait
// donc plus que les frais encaissés — supportable tant que Livraisanté gardait
// la moitié, déficitaire depuis que la totalité revient au club.
const CLUB_SHARE_RATE=1.00;
//
// ── Correctif audit 2026-08-05 (Critique #1) ────────────────────────────────
// `stripe-webhook` était censé notifier le patient (push + email facture) une
// fois le paiement confirmé, mais recherchait la commande via `pi.metadata.orderId`
// — un champ jamais renseigné (code mort, voir stripe-webhook/index.ts). Aucune
// notification ne partait donc jamais. Comme cette fonction est le seul chemin
// SYNCHRONE et fiable de création de commande payante (garanti de s'exécuter dans
// la requête du client, contrairement à un webhook asynchrone), la notification
// est désormais envoyée ICI, juste après l'insertion — et seulement lors de la
// création initiale (jamais sur le replay idempotent d'un paiement déjà traité).
import Stripe from 'npm:stripe@14.21.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders={
  'Access-Control-Allow-Origin':'https://www.livraisante.fr',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
};

const ALLOWED_KINDS=['santé','click-collect','cnc-club'];
const DELIVERY_MODE_BY_KIND: Record<string,string>={ 'santé':'livraison', 'click-collect':'cnc', 'cnc-club':'cnc_club' };
const MAX_ITEMS=30;

// Appel d'une Edge Function depuis une autre. `functions.invoke` échouait
// systématiquement sur ce trajet — vérifié sur signup-verification, où le passage à
// fetch a suffi à réparer l'envoi. Ici les deux appels sont délibérément non bloquants,
// donc l'échec était avalé : ni la facture ni la notification ne sont jamais parties
// après une commande, sans que rien ne l'indique dans la réponse HTTP.
// On lève en cas de statut non-2xx pour que les catch des appelants journalisent la
// cause au lieu de constater un succès qui n'en est pas un.
async function callEdgeFunction(baseUrl:string,name:string,body:unknown,bearer:string,apikey:string){
  const res=await fetch(`${baseUrl}/functions/v1/${name}`,{
    method:'POST',
    headers:{ 'Authorization':bearer, 'apikey':apikey, 'Content-Type':'application/json' },
    body:JSON.stringify(body),
  });
  if(!res.ok){
    const detail=await res.text().catch(()=>'');
    throw new Error(`${name} a répondu ${res.status} — ${detail.slice(0,200)}`);
  }
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders});
  try{
    const body=await req.json();
    // ── Correctif audit 2026-09-21 (Critique, faille 1) ──────────────────────
    // `items` et `pharmacyId` ne sont VOLONTAIREMENT plus lus du corps de la
    // requête. Ils proviennent désormais de `payment_carts`, écrit par
    // create-payment-intent au moment où le montant a été calculé. Le client peut
    // continuer à les envoyer (le front le fait encore), ils sont ignorés.
    const { paymentIntentId, id, code, kind, patient }=body||{};

    if(typeof paymentIntentId!=='string'||!paymentIntentId.startsWith('pi_')){
      return new Response(JSON.stringify({error:'paymentIntentId invalide'}),{status:400,headers:corsHeaders});
    }
    if(typeof id!=='string'||!id){
      return new Response(JSON.stringify({error:'id invalide'}),{status:400,headers:corsHeaders});
    }
    if(!ALLOWED_KINDS.includes(kind)){
      return new Response(JSON.stringify({error:'kind invalide'}),{status:400,headers:corsHeaders});
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
    // ── Correctif audit 2026-09-21 (Critique, faille 2) ──────────────────────
    // `totalEur` plus bas vaut `pi.amount/100`, ce qui ne tient QUE pour une
    // devise à deux décimales. create-payment-intent force désormais l'euro,
    // mais un PaymentIntent créé avant ce correctif (ou par un autre chemin)
    // pourrait porter une devise à zéro décimale : on refuse explicitement
    // plutôt que d'enregistrer un montant faux et de créditer la cagnotte
    // dessus.
    if(pi.currency!=='eur'){
      console.error('confirm-order devise inattendue',{paymentIntentId,currency:pi.currency});
      return new Response(JSON.stringify({error:'Devise de paiement non prise en charge'}),{status:400,headers:corsHeaders});
    }

    // Idempotence (chemin rapide) : un même PaymentIntent ne doit créer qu'une
    // seule commande (double-clic, retry réseau de createOrder/index.html:5587,
    // rejeu de resumePendingOrderConfirmation...). Si la commande existe déjà,
    // on la renvoie telle quelle.
    //
    // Cette relecture est faite AVANT les vérifications de panier ci-dessous, et
    // non après : une commande déjà créée n'a plus rien à prouver — le panier a
    // servi à la créer, il a pu depuis être purgé (cleanup_stale_payment_carts)
    // ou ne jamais avoir existé pour un paiement antérieur à ce correctif. La
    // faire échouer sur un panier manquant reviendrait à rendre infinalisable
    // une commande déjà payée ET déjà enregistrée.
    const {data:existingOrder}=await supabaseAdmin
      .from('orders').select('*')
      .eq('payment->>paymentIntentId', paymentIntentId)
      .maybeSingle();
    if(existingOrder){
      return new Response(JSON.stringify({order:existingOrder}),{
        headers:{...corsHeaders,'Content-Type':'application/json'}
      });
    }

    // ── Correctif audit 2026-09-21 (Critique, faille 1) ──────────────────────
    // Le panier facturé est relu depuis `payment_carts` (écrit par
    // create-payment-intent avec service_role, table inaccessible aux clients).
    // C'est ce qui rattache enfin le CONTENU de la commande au montant payé :
    // auparavant, on pouvait payer un panier d'un article puis faire enregistrer
    // une commande de trente articles.
    const {data:cart,error:cartErr}=await supabaseAdmin
      .from('payment_carts').select('*')
      .eq('payment_intent_id',paymentIntentId)
      .maybeSingle();
    if(cartErr||!cart){
      console.error('confirm-order panier introuvable',{paymentIntentId,cartErr});
      return new Response(JSON.stringify({error:'Panier introuvable pour ce paiement.'}),{status:400,headers:corsHeaders});
    }
    if(cart.user_id!==userId){
      return new Response(JSON.stringify({error:"Ce panier n'appartient pas à cet utilisateur"}),{status:403,headers:corsHeaders});
    }
    // Le montant relu chez Stripe doit être celui calculé au moment où ce panier
    // a été figé — sinon le PaymentIntent et le panier ne vont pas ensemble.
    if(Number(cart.amount_cents)!==Number(pi.amount)){
      console.error('confirm-order montant/panier désaccordés',{paymentIntentId,cart:cart.amount_cents,pi:pi.amount});
      return new Response(JSON.stringify({error:'Paiement et panier incohérents.'}),{status:400,headers:corsHeaders});
    }
    // Les frais de livraison dépendent du mode : accepter un `kind` qui ne
    // correspond pas au mode facturé reviendrait à payer un click-collect
    // (0 € de frais) puis à se faire livrer.
    if(DELIVERY_MODE_BY_KIND[kind]!==cart.delivery_mode){
      return new Response(JSON.stringify({error:'Mode de livraison incohérent avec le paiement.'}),{status:400,headers:corsHeaders});
    }

    const cartItems=Array.isArray(cart.items)?cart.items:[];
    if(cartItems.length===0||cartItems.length>MAX_ITEMS){
      return new Response(JSON.stringify({error:'Panier invalide'}),{status:400,headers:corsHeaders});
    }
    // Forme d'affichage attendue par le front (cf. orderItemsHtml/index.html),
    // reconstruite ICI à partir du panier canonique plutôt que reçue du client.
    const items=cartItems.map((it:any)=>({name:`${it?.name??''} (${it?.lab??''})`,ev:'—'}));
    const pharmacyId=cart.pharmacy_id;

    const totalEur=pi.amount/100;
    const deliveryFeeCents=Number(pi.metadata?.deliveryFeeCents||0);
    const deliveryFeeEur=deliveryFeeCents/100;
    const commissionCents=Number(pi.metadata?.commissionCents||0);
    const commissionEur=Number.isFinite(commissionCents)?commissionCents/100:0;

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
      pricing: { totalEur, deliveryFeeEur, commissionEur },
      payment: { email: patient?.email||'', donation: patient?.donation||null, paymentIntentId },
    };
    const {data,error}=await supabaseAdmin.from('orders').insert(row).select().single();
    if(error){
      // ── Correctif audit sécurité/perf 2026-08-05 ─────────────────────────
      // Le message d'erreur Postgres/PostgREST brut (contrainte violée, colonne
      // inconnue, détail RLS...) était renvoyé tel quel au client. Un appelant
      // pouvait s'en servir pour sonder le schéma de la base (noms de colonnes,
      // contraintes, structure des policies). Le détail part maintenant
      // uniquement dans les logs serveur ; le client ne reçoit qu'un message
      // générique.
      console.error('confirm-order insert error',error);
      // ── Correctif audit 2026-09-21 (Critique, faille 3) ───────────────────
      // Le SELECT d'idempotence plus haut est une optimisation, pas une
      // garantie : entre ce SELECT et cet INSERT, une requête concurrente
      // portant le même paymentIntentId (et un `id` différent, puisque `id` est
      // choisi par le client) passait elle aussi — deux commandes pour un seul
      // paiement, et surtout deux crédits de cagnotte, la contrainte UNIQUE de
      // `club_cagnotte_entries` portant sur `order_id` et non sur le paiement.
      // La garantie tient désormais en base (idx_orders_payment_intent_unique,
      // migration 20260921000000). Reste à traduire la violation 23505 en
      // réponse idempotente : sans ça, un simple double-clic renverrait une 500
      // alors que la commande a bel et bien été créée.
      if((error as any)?.code==='23505'){
        const {data:raced}=await supabaseAdmin
          .from('orders').select('*')
          .eq('payment->>paymentIntentId', paymentIntentId)
          .maybeSingle();
        // Les effets de bord (cagnotte, push, email) appartiennent à la requête
        // qui a gagné la course : on ne les rejoue pas ici.
        if(raced && raced.patient_id===userId){
          return new Response(JSON.stringify({order:raced}),{
            headers:{...corsHeaders,'Content-Type':'application/json'}
          });
        }
      }
      return new Response(JSON.stringify({error:"Impossible d'enregistrer la commande. Réessayez dans un instant."}),{status:500,headers:corsHeaders});
    }

    // ── Cagnotte club + notifications (best-effort) — voir notes en tête de
    // fichier. Les trois effets de bord ci-dessous sont indépendants les uns
    // des autres (aucun ne dépend du résultat d'un autre) : on les lance donc
    // en parallèle plutôt que séquentiellement (correctif audit performances
    // 2026-08-05 — l'ancien code attendait la cagnotte, PUIS le push, PUIS
    // l'email l'un après l'autre, ajoutant inutilement leurs latences bout à
    // bout avant de répondre au client déjà débité). Chacun a son propre
    // try/catch : l'échec d'un canal ne doit jamais empêcher les autres, et
    // aucun des trois ne doit jamais faire échouer la réponse — la commande
    // est déjà créée et payée à ce stade.
    const cagnottePromise=(async()=>{
      try{
        const {data:membership}=await supabaseAdmin
          .from('club_members').select('club_id')
          .eq('user_id',userId).eq('validated',true)
          .maybeSingle();
        if(membership?.club_id){
          const amountEur=Math.round(commissionEur*CLUB_SHARE_RATE*100)/100;
          if(amountEur>0){
            await supabaseAdmin.from('club_cagnotte_entries').insert({
              club_id: membership.club_id,
              order_id: id,
              patient_id: userId,
              amount_eur: amountEur,
            });
          }
        }
      }catch(cagnotteErr){
        console.error('confirm-order cagnotte club (non bloquant)',cagnotteErr);
      }
    })();

    const anonKeyForCalls=Deno.env.get('SUPABASE_ANON_KEY')||serviceRoleKey;

    const pushPromise=callEdgeFunction(supabaseUrl,'send-push',{
      user_id:userId, title:'✅ Commande validée', body:`Votre paiement de ${totalEur}€ a été accepté. Votre commande est en préparation.`, url:'/#commandes'
    },`Bearer ${serviceRoleKey}`,anonKeyForCalls).catch(pushErr=>console.error('confirm-order push (non bloquant)',pushErr));

    const emailPromise=(async()=>{
      if(!patient?.email) return;
      try{
        const {data:pharmacy}=await supabaseAdmin.from('pharmacies').select('nom').eq('id',pharmacyId).maybeSingle();
        const medicaments=Array.isArray(items)?items.map((it:any)=>it?.name).filter(Boolean).join(', '):'';
        // `send-email` exige un JWT utilisateur valide pour type='validation' (pas
        // un appel service_role — voir send-email/index.ts) : on relaie le JWT du
        // patient déjà vérifié plus haut, plutôt que la clé service_role de ce client.
        if(!authHeader) throw new Error('aucun JWT patient à relayer — send-email refuserait le type validation');
        await callEdgeFunction(supabaseUrl,'send-email',{
          type:'validation',
          to:patient.email,
          order:{ id, patient_nom:patient?.name||'', pharmacy_nom:pharmacy?.nom||'', medicaments, adresse:patient?.addr||'', montant:totalEur }
        },authHeader,anonKeyForCalls);
      }catch(emailErr){
        console.error('confirm-order email (non bloquant)',emailErr);
      }
    })();

    await Promise.allSettled([cagnottePromise, pushPromise, emailPromise]);

    return new Response(JSON.stringify({order:data}),{
      headers:{...corsHeaders,'Content-Type':'application/json'}
    });
  }catch(err){
    console.error('confirm-order unhandled error',err);
    return new Response(JSON.stringify({error:'Une erreur est survenue lors de la confirmation de la commande.'}),{status:500,headers:corsHeaders});
  }
});
