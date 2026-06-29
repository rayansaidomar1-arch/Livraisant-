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
      // Fallback : utiliser le montant fourni par le client (compatibilité)
      if(!amount||amount<50) return new Response(JSON.stringify({error:'Montant minimum 0.50€'}),{status:400,headers:corsHeaders});
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
