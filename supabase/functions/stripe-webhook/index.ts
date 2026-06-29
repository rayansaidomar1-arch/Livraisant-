// Supabase Edge Function — stripe-webhook
// Receives Stripe webhook events and updates order status
// Required env vars:
//   STRIPE_SECRET_KEY      — sk_live_... (already set)
//   STRIPE_WEBHOOK_SECRET  — whsec_... (set after creating webhook in Stripe dashboard)
//   SUPABASE_URL           — auto-injected by Supabase
//   SERVICE_ROLE_KEY — set via Supabase dashboard (SUPABASE_ prefix is reserved)

import Stripe from 'npm:stripe@14.21.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

// Webhook Stripe = appel serveur→serveur uniquement, pas de CORS nécessaire
const webhookHeaders = { 'Content-Type': 'application/json' };

Deno.serve(async (req) => {
  // Rejeter toute requête non-POST (le webhook Stripe envoie uniquement des POST)
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SERVICE_ROLE_KEY')!;

  try {
    const body = await req.text();
    const signature = req.headers.get('stripe-signature');

    // Verify webhook signature
    if (!webhookSecret) {
      console.error('CRITICAL: STRIPE_WEBHOOK_SECRET not configured');
      return new Response(JSON.stringify({ error: 'Webhook secret not configured' }), { status: 500 });
    }
    if (!signature) {
      return new Response(JSON.stringify({ error: 'Missing stripe-signature header' }), { status: 400 });
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.orderId;
        if (orderId) {
          const { data: order } = await supabase
            .from('orders')
            .select('patient_id, medicaments, adresse_livraison, pharmacy_id, profiles(prenom, nom, email), pharmacies(nom)')
            .eq('id', orderId).single();
          await supabase
            .from('orders')
            .update({ payment: { status: 'paid', payment_intent_id: pi.id, amount: pi.amount }, status: 'validee', updated_at: new Date().toISOString() })
            .eq('id', orderId);
          // Notification push au patient
          if (order?.patient_id) {
            await supabase.functions.invoke('send-push', {
              body: { user_id: order.patient_id, title: '✅ Commande validée', body: `Votre paiement de ${pi.amount / 100}€ a été accepté. Votre commande est en préparation.`, url: '/#commandes' }
            });
          }
          // Email de validation avec facture
          const patientEmail = (order as any)?.profiles?.email;
          if (patientEmail) {
            await supabase.functions.invoke('send-email', {
              body: {
                type: 'validation',
                to: patientEmail,
                order: {
                  id: orderId,
                  patient_nom: `${(order as any)?.profiles?.prenom || ''} ${(order as any)?.profiles?.nom || ''}`.trim(),
                  pharmacy_nom: (order as any)?.pharmacies?.nom || '',
                  medicaments: (order as any)?.medicaments || '',
                  adresse: (order as any)?.adresse_livraison || '',
                  montant: pi.amount / 100,
                }
              }
            });
          }
          console.log(`✅ Order marked as paid — ${pi.amount / 100}€`);
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
          console.log(`❌ Payment failed`);
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const orderId = charge.metadata?.orderId;
        if (orderId) {
          const { data: order } = await supabase.from('orders').select('patient_id').eq('id', orderId).single();
          await supabase
            .from('orders')
            .update({ payment: { status: 'refunded', charge_id: charge.id }, status: 'annulee', updated_at: new Date().toISOString() })
            .eq('id', orderId);
          // Notification push au patient
          if (order?.patient_id) {
            await supabase.functions.invoke('send-push', {
              body: { user_id: order.patient_id, title: '↩️ Remboursement effectué', body: 'Votre commande a été annulée et remboursée.', url: '/#commandes' }
            });
          }
          console.log(`↩️ Order refunded`);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: webhookHeaders
    });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
