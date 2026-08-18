// Supabase Edge Function — stripe-webhook
// Receives Stripe webhook events and updates order status
// Required env vars:
//   STRIPE_SECRET_KEY      — sk_live_... (already set)
//   STRIPE_WEBHOOK_SECRET  — whsec_... (set after creating webhook in Stripe dashboard)
//   SUPABASE_URL           — auto-injected by Supabase
//   SERVICE_ROLE_KEY — set via Supabase dashboard (SUPABASE_ prefix is reserved)
//
// ── Correctif audit 2026-08-05 (Critique #1) ─────────────────────────────────
// Ce webhook cherchait la commande via `pi.metadata.orderId` / `charge.metadata.orderId`
// — un champ que ni `create-payment-intent` ni le client ne renseignent jamais (l'id de
// commande n'existe pas encore quand le PaymentIntent est créé). Les 3 handlers étaient
// donc du code mort : aucune commande n'était jamais retrouvée. Le handler `succeeded`
// forçait en plus `status:'validee'` directement — ce qui, s'il avait un jour fonctionné,
// aurait court-circuité la validation manuelle du pharmacien (cf. renderPro()/setStatus()
// dans index.html, qui n'affiche "Valider la demande" que pour `status==='nouvelle'`).
//
// Désormais :
// - la création de la commande + la notification patient (push/email) se font de façon
//   SYNCHRONE dans `confirm-order`, juste après vérification du paiement — c'est le
//   chemin fiable, garanti de s'exécuter dans la requête du client ;
// - ce webhook redevient ce qu'un webhook Stripe doit être : un filet de secours
//   asynchrone, qui retrouve la commande par `payment->>paymentIntentId` (même clé
//   d'idempotence que `confirm-order`) et NE TOUCHE JAMAIS à `status` (réservé au
//   workflow pharmacien), sauf pour `charge.refunded` où l'annulation est légitimement
//   pilotée par Stripe seul ;
// - si aucune commande n'est trouvée pour un paiement réussi, c'est une course bénigne
//   dans la majorité des cas (le webhook peut arriver avant que `confirm-order` ait fini
//   d'écrire la commande) : on se contente de logger, la commande sera de toute façon
//   rattrapée par `resumePendingOrderConfirmation()` côté client si besoin.

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

    // Retrouve une commande par PaymentIntent id — même clé d'idempotence que
    // `confirm-order` (`payment->>paymentIntentId`), plutôt que le champ
    // `metadata.orderId` jamais renseigné.
    async function findOrderByPaymentIntent(paymentIntentId: string) {
      const { data } = await supabase
        .from('orders').select('id, status, patient_id, payment')
        .eq('payment->>paymentIntentId', paymentIntentId)
        .maybeSingle();
      return data;
    }

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const order = await findOrderByPaymentIntent(pi.id);
        if (!order) {
          // Bénin dans la majorité des cas : `confirm-order` n'a pas encore écrit la
          // commande au moment où ce webhook arrive (course bénigne). Elle sera de
          // toute façon créée par `confirm-order`, ou rattrapée côté client par
          // `resumePendingOrderConfirmation()` si ce dernier a échoué.
          console.log(`payment_intent.succeeded (${pi.id}) : aucune commande trouvée pour l'instant`);
          break;
        }
        // Réconciliation uniquement — ne touche jamais à `status` (workflow pharmacien,
        // déclenché manuellement via setStatus()). Enrichit seulement `payment`.
        await supabase
          .from('orders')
          .update({ payment: { ...(order.payment || {}), status: 'paid', payment_intent_id: pi.id, amount: pi.amount }, updated_at: new Date().toISOString() })
          .eq('id', order.id);
        console.log(`✅ Order ${order.id} reconciled as paid — ${pi.amount / 100}€`);
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const order = await findOrderByPaymentIntent(pi.id);
        if (order) {
          await supabase
            .from('orders')
            .update({ payment: { ...(order.payment || {}), status: 'failed', payment_intent_id: pi.id, error: pi.last_payment_error?.message }, updated_at: new Date().toISOString() })
            .eq('id', order.id);
          console.log(`❌ Payment failed for order ${order.id}`);
        } else {
          // Cas normal : `confirm-order` refuse de créer une commande tant que le
          // paiement n'a pas réussi, donc aucune commande n'existe encore ici.
          console.log(`payment_intent.payment_failed (${pi.id}) : pas de commande associée (attendu)`);
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
        const order = paymentIntentId ? await findOrderByPaymentIntent(paymentIntentId) : null;
        if (order) {
          await supabase
            .from('orders')
            .update({ payment: { ...(order.payment || {}), status: 'refunded', charge_id: charge.id }, status: 'annulee', updated_at: new Date().toISOString() })
            .eq('id', order.id);
          // Notification push au patient — cas légitimement piloté par Stripe seul
          // (un remboursement peut être déclenché depuis le dashboard Stripe, sans
          // aucune action côté client à ce moment-là).
          if (order.patient_id) {
            await supabase.functions.invoke('send-push', {
              body: { user_id: order.patient_id, title: '↩️ Remboursement effectué', body: 'Votre commande a été annulée et remboursée.', url: '/#commandes' }
            });
          }
          console.log(`↩️ Order ${order.id} refunded`);
        } else {
          console.error(`charge.refunded (${charge.id}) : aucune commande trouvée pour paymentIntent=${paymentIntentId}`);
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
