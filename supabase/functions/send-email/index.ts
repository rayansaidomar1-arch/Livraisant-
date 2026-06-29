// Supabase Edge Function — send-email
// Envoie des emails transactionnels via Resend
// Env vars requis :
//   RESEND_API_KEY  — re_... (depuis resend.com)
//   FROM_EMAIL      — noreply@livraisante.fr (domaine vérifié sur Resend)

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://www.livraisante.fr',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { type, to, order } = await req.json();
    // type: 'preparation' | 'validation'
    // to: 'patient@email.fr'
    // order: { id, patient_nom, medicaments, montant, adresse, pharmacy_nom, date }

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
    const FROM = Deno.env.get('FROM_EMAIL') || 'noreply@livraisante.fr';

    let subject = '';
    let html = '';

    if (type === 'preparation') {
      subject = `🔄 Votre commande est en préparation — Livraisanté`;
      html = emailPreparation(order);
    } else if (type === 'validation') {
      subject = `✅ Commande validée — Facture #${order.id?.slice(0, 8).toUpperCase()} — Livraisanté`;
      html = emailValidation(order);
    } else {
      return new Response(JSON.stringify({ error: 'Type inconnu' }), { status: 400, headers: corsHeaders });
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Livraisanté <${FROM}>`, to: [to], subject, html }),
    });

    const data = await res.json();
    if (!res.ok) return new Response(JSON.stringify({ error: data }), { status: 500, headers: corsHeaders });
    return new Response(JSON.stringify({ sent: true, id: data.id }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
});

// ── Template : Commande en préparation ───────────────────────────────
function emailPreparation(o: any): string {
  const date = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  return `
<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  <div style="background:#0D0E09;padding:28px 32px;text-align:center">
    <span style="font-size:28px;font-weight:900;color:#C2F23E;letter-spacing:-.5px">Livraisanté</span>
  </div>
  <div style="padding:36px 32px">
    <div style="background:#fef9c3;border-left:4px solid #eab308;border-radius:10px;padding:14px 18px;margin-bottom:24px;font-size:14px;font-weight:700;color:#854d0e">
      🔄 Votre commande est en cours de préparation
    </div>
    <h2 style="font-size:19px;font-weight:800;margin:0 0 8px;color:#0D0E09">Bonjour ${o.patient_nom || 'cher client'} 👋</h2>
    <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 20px">
      La pharmacie <strong>${o.pharmacy_nom || 'partenaire'}</strong> prépare actuellement votre commande. Vous serez notifié(e) dès qu'un livreur prend en charge la livraison.
    </p>
    <div style="background:#f8f8f8;border-radius:12px;padding:18px 20px;margin-bottom:24px">
      <div style="font-weight:800;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:12px">Récapitulatif de commande</div>
      <div style="font-size:13px;color:#555;font-family:monospace;white-space:pre-wrap">${o.medicaments || 'Médicaments sur ordonnance'}</div>
      <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:12px;display:flex;justify-content:space-between">
        <span style="font-weight:700;color:#0D0E09">Total</span>
        <span style="font-weight:800;font-size:17px;color:#0D0E09">${o.montant ? `€${Number(o.montant).toFixed(2)}` : '—'}</span>
      </div>
    </div>
    <div style="font-size:13px;color:#666;line-height:1.6">
      📍 Livraison prévue à : <strong>${o.adresse || 'votre adresse enregistrée'}</strong>
    </div>
  </div>
  <div style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:12px;color:#999">
    Référence commande : <strong>${o.id?.slice(0, 8).toUpperCase() || '—'}</strong> · ${date}<br>
    © Livraisanté · 1 Rue des Vergers, 69120 Vaulx-en-Velin
  </div>
</div>`;
}

// ── Template : Commande validée + Facture ────────────────────────────
function emailValidation(o: any): string {
  const date = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const refId = (o.id?.slice(0, 8) || 'XXXXXXXX').toUpperCase();
  const montantHT = o.montant ? (Number(o.montant) / 1.055).toFixed(2) : '—';
  const tva = o.montant ? (Number(o.montant) - Number(montantHT)).toFixed(2) : '—';
  const montantTTC = o.montant ? Number(o.montant).toFixed(2) : '—';

  return `
<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  <div style="background:#0D0E09;padding:28px 32px;text-align:center">
    <span style="font-size:28px;font-weight:900;color:#C2F23E;letter-spacing:-.5px">Livraisanté</span>
  </div>
  <div style="padding:36px 32px">
    <div style="background:#dcfce7;border-left:4px solid #16a34a;border-radius:10px;padding:14px 18px;margin-bottom:24px;font-size:14px;font-weight:700;color:#166534">
      ✅ Commande validée et payée !
    </div>
    <h2 style="font-size:19px;font-weight:800;margin:0 0 8px;color:#0D0E09">Merci ${o.patient_nom || 'pour votre confiance'} 🎉</h2>
    <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 24px">
      Votre commande a été livrée avec succès. Retrouvez ci-dessous votre facture.
    </p>

    <!-- FACTURE -->
    <div style="border:2px solid #0D0E09;border-radius:14px;overflow:hidden;margin-bottom:24px">
      <div style="background:#0D0E09;padding:14px 20px;display:flex;justify-content:space-between;align-items:center">
        <span style="color:#C2F23E;font-weight:800;font-size:15px">FACTURE</span>
        <span style="color:#fff;font-size:13px">#${refId}</span>
      </div>
      <div style="padding:18px 20px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px;color:#555">
          <span>Date</span><span style="font-weight:700;color:#0D0E09">${date}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px;color:#555">
          <span>Pharmacie</span><span style="font-weight:700;color:#0D0E09">${o.pharmacy_nom || '—'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px;color:#555">
          <span>Adresse de livraison</span><span style="font-weight:700;color:#0D0E09;text-align:right;max-width:220px">${o.adresse || '—'}</span>
        </div>
        <div style="border-top:1px solid #e5e7eb;margin:14px 0 12px"></div>
        <div style="font-size:13px;color:#555;margin-bottom:10px;white-space:pre-wrap">${o.medicaments || 'Médicaments'}</div>
        <div style="border-top:1px solid #e5e7eb;margin:12px 0 10px"></div>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#666;margin-bottom:4px">
          <span>Montant HT</span><span>€${montantHT}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#666;margin-bottom:10px">
          <span>TVA (5,5%)</span><span>€${tva}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-weight:800;font-size:16px;color:#0D0E09">
          <span>Total TTC</span><span>€${montantTTC}</span>
        </div>
        <div style="margin-top:12px;background:#f0fdf4;border-radius:8px;padding:10px 14px;font-size:12px;color:#166534;font-weight:700;text-align:center">
          ✅ Paiement reçu — Merci !
        </div>
      </div>
    </div>

    <p style="font-size:13px;color:#888;line-height:1.5">
      Conservez cet email comme justificatif. Pour toute question : <a href="mailto:contact@livraisante.fr" style="color:#0D0E09">contact@livraisante.fr</a>
    </p>
  </div>
  <div style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:12px;color:#999">
    © Livraisanté SAS · RCS Lyon 933 484 917 · 1 Rue des Vergers, 69120 Vaulx-en-Velin
  </div>
</div>`;
}
