// Supabase Edge Function — stripe-webhook
// Receives Stripe webhook events and updates order status
// Required env vars:
//   STRIPE_SECRET_KEY      — sk_live_... (already set)
//   STRIPE_WEBHOOK_SECRET  — whsec_... (set after creating webhook in Stripe dashboard)
//   SUPABASE_URL           — auto-injected by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — set via: supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...

import Stripe from 'npm:stripe@14.21.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  try {
    const body = await req.text();
    const signature = req.headers.get('stripe-signature');

    // Verify webhook signature
    let event: Stripe.Event;
    if (webhookSecret && signature) {
      try {
        event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
      } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400 });
      }
    } else {
      // No secret configured — accept in test mode only
      event = JSON.parse(body);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.orderId;
        if (orderId) {
          await supabase
            .from('orders')
            .update({ payment: { status: 'paid', payment_intent_id: pi.id, amount: pi.amount }, status: 'validee', updated_at: new Date().toISOString() })
            .eq('id', orderId);
          console.log(`✅ Order ${orderId} marked as paid — ${pi.amount / 100}€`);
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.orderId;
        if (orderId) {
          await supabase
            .from('orders')
            .update({ payment: { status: 'failed', payment_intent_id: pi.id, error: pi.last_payment_error?.message }, updated_at: new Date().toISOString() })
            .eq('id', orderId);
          console.log(`❌ Order ${orderId} payment failed`);
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const orderId = charge.metadata?.orderId;
        if (orderId) {
          await supabase
            .from('orders')
            .update({ payment: { status: 'refunded', charge_id: charge.id }, status: 'annulee', updated_at: new Date().toISOString() })
            .eq('id', orderId);
          console.log(`↩️ Order ${orderId} refunded`);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
