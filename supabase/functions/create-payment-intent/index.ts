// Supabase Edge Function — create-payment-intent
// Deploy: supabase functions deploy create-payment-intent
// Required env var: STRIPE_SECRET_KEY (set via: supabase secrets set STRIPE_SECRET_KEY=sk_live_...)
import Stripe from 'npm:stripe@14.21.0';

const corsHeaders={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders});
  try{
    const {amount,currency='eur',metadata={}}=await req.json();
    if(!amount||amount<50) return new Response(JSON.stringify({error:'Montant minimum 0.50€'}),{status:400,headers:corsHeaders});
    const stripe=new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!,{apiVersion:'2024-06-20'});
    const paymentIntent=await stripe.paymentIntents.create({
      amount:Math.round(amount), currency,
      automatic_payment_methods:{enabled:true},
      metadata:{...metadata,platform:'livraisante'},
    });
    return new Response(JSON.stringify({clientSecret:paymentIntent.client_secret}),{
      headers:{...corsHeaders,'Content-Type':'application/json'}
    });
  }catch(err){
    return new Response(JSON.stringify({error:err.message}),{status:500,headers:corsHeaders});
  }
});
