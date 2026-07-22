// Supabase Edge Function — send-email
// Envoie des emails transactionnels via Resend
// Env vars requis :
//   RESEND_API_KEY  — re_... (depuis resend.com)
//   FROM_EMAIL      — noreply@livraisante.fr (domaine vérifié sur Resend)
//   SUPABASE_URL / SUPABASE_ANON_KEY — pour vérifier le JWT de l'appelant (auth requise
//   sur 'preparation'/'validation', voir correctif ci-dessous)

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://www.livraisante.fr',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Échappe le HTML pour éviter toute injection dans le corps de l'email — les champs
// `order.*` (nom patient, nom pharmacie, médicaments, adresse) viennent tels quels du
// client et ne sont pas des identifiants système, donc ne pas les échapper permettrait
// d'injecter des liens de phishing ou de casser la mise en page de l'email.
function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ── Correctif audit sécurité 2026-07-23 (Élevé #6) ───────────────────
// Le sujet de l'email `candidature_pharmacie` interpolait `order.pharmacy_nom`
// (texte libre saisi sur un formulaire PUBLIC, non authentifié) directement
// dans le sujet, sans le passer par `escapeHtml` (qui ne protège de toute façon
// que le HTML, pas un en-tête d'email) ni aucune limite de longueur. Un CR/LF
// dans ce champ pourrait tenter une injection d'en-têtes email (ex. Bcc:) selon
// la façon dont l'API Resend traite le champ `subject` ; à défaut, un nom
// anormalement long ou contenant des caractères de contrôle dégraderait le
// sujet reçu par l'admin. Même règle appliquée à `order.id` (utilisé tel quel
// dans les sujets 'preparation'/'validation') par prudence, même si sa forme
// est normalement contrôlée en interne.
// Fix : retirer tout caractère de contrôle (\r,\n,\t,\0) et borner la longueur
// avant toute interpolation dans un sujet d'email (jamais dans un en-tête brut,
// on passe par l'API JSON de Resend, mais on ne fait plus confiance à ça seul).
function sanitizeForSubject(v: unknown, maxLen = 120): string {
  return String(v ?? '').replace(/[\r\n\t\0]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { type, to, order: rawOrder } = await req.json();
    // type: 'preparation' | 'validation' | 'candidature_pharmacie'
    // to: 'patient@email.fr' (ignoré pour 'candidature_pharmacie', destinataire fixé côté serveur)
    // order: { id, patient_nom, medicaments, montant, adresse, pharmacy_nom, date }

    // ── Correctif (2026-07-16) — ce endpoint permettait à n'importe qui (y compris
    // anonyme) de faire relayer un email arbitraire par le domaine Livraisanté vers
    // n'importe quelle adresse `to` (phishing/spam), avec du contenu non échappé.
    // 'candidature_pharmacie' reste accessible sans authentification (formulaire
    // public de candidature pharmacie, destinataire fixé côté serveur = ADMIN_EMAIL,
    // donc pas de relai arbitraire possible). En revanche 'preparation'/'validation'
    // envoient vers une adresse `to` fournie par le client : on exige désormais un
    // utilisateur authentifié pour ces deux types.
    let authedUserId: string | null = null;
    if (type === 'preparation' || type === 'validation') {
      const authHeader = req.headers.get('Authorization') || '';
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
      if (!authHeader || !supabaseUrl || !anonKey) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }
      const anonClient = createClient(supabaseUrl, anonKey);
      const { data: { user } } = await anonClient.auth.getUser(authHeader.replace(/^Bearer /, ''));
      if (!user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }
      authedUserId = user.id;
      if (!to || !EMAIL_RE.test(to)) {
        return new Response(JSON.stringify({ error: 'Adresse destinataire invalide' }), { status: 400, headers: corsHeaders });
      }
    }

    // ── Rate-limiting (audit 2026-07-23, Moyen) ───────────────────────────
    // 'preparation'/'validation' sont authentifiés → clé sur l'utilisateur.
    // 'candidature_pharmacie' est public (formulaire sans compte, pas de JWT) →
    // clé sur l'IP, seul identifiant disponible pour limiter un abus du
    // formulaire public (spam de la boîte admin). Échec de l'appel RPC
    // lui-même = fail-open : le rate-limiting est une protection en
    // profondeur, il ne doit pas bloquer un envoi légitime si l'infra a un
    // souci passager.
    if (type === 'preparation' || type === 'validation' || type === 'candidature_pharmacie') {
      const rlBucket = authedUserId
        ? `send-email:${authedUserId}`
        : `send-email-candidature:${(req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'}`;
      const rlMax = authedUserId ? 15 : 5;
      const rlWindow = authedUserId ? 600 : 3600;
      try {
        const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SERVICE_ROLE_KEY')!);
        const { data: allowed, error: rlErr } = await supabaseAdmin.rpc('check_rate_limit', {
          p_bucket: rlBucket, p_max_hits: rlMax, p_window_seconds: rlWindow,
        });
        if (!rlErr && allowed === false) {
          return new Response(JSON.stringify({ error: 'Trop de requêtes, réessayez plus tard.' }), { status: 429, headers: corsHeaders });
        }
      } catch (_e) { /* fail-open volontaire, voir commentaire ci-dessus */ }
    }

    // Échappe tous les champs texte libres avant de les passer aux templates HTML
    const order = rawOrder ? {
      ...rawOrder,
      patient_nom: escapeHtml(rawOrder.patient_nom),
      pharmacy_nom: escapeHtml(rawOrder.pharmacy_nom),
      medicaments: escapeHtml(rawOrder.medicaments),
      adresse: escapeHtml(rawOrder.adresse),
    } : rawOrder;

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
    const FROM = Deno.env.get('FROM_EMAIL') || 'noreply@livraisante.fr';
    const ADMIN_EMAIL = Deno.env.get('ADMIN_EMAIL') || 'administratif@livraisante.fr';

    let subject = '';
    let html = '';
    let recipients: string[];

    if (type === 'preparation') {
      subject = `🔄 Votre commande est en préparation — Livraisanté`;
      html = emailPreparation(order);
      recipients = [to];
    } else if (type === 'validation') {
      const refId = sanitizeForSubject(order.id?.slice(0, 8)?.toUpperCase(), 20);
      subject = `✅ Commande validée — Facture #${refId} — Livraisanté`;
      html = emailValidation(order);
      recipients = [to];
    } else if (type === 'candidature_pharmacie') {
      // Notification interne — destinataire fixé côté serveur (pas de valeur `to` fournie
      // par le client) pour éviter tout détournement de ce endpoint en relai d'emails arbitraires.
      const pharmaNom = sanitizeForSubject(order?.pharmacy_nom) || 'sans nom';
      subject = `🏥 Nouvelle candidature pharmacie — ${pharmaNom}`;
      html = emailCandidaturePharmacie(order);
      recipients = [ADMIN_EMAIL];
    } else {
      return new Response(JSON.stringify({ error: 'Type inconnu' }), { status: 400, headers: corsHeaders });
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Livraisanté <${FROM}>`, to: recipients, subject, html }),
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

// ── Template : Notification interne — nouvelle candidature pharmacie ──
function emailCandidaturePharmacie(o: any): string {
  const date = new Date().toLocaleString('fr-FR');
  return `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  <div style="background:#0D0E09;padding:24px 32px;text-align:center">
    <span style="font-size:24px;font-weight:900;color:#C2F23E">Livraisanté — Admin</span>
  </div>
  <div style="padding:32px">
    <div style="background:#fef9c3;border-left:4px solid #eab308;border-radius:10px;padding:14px 18px;margin-bottom:22px;font-size:14px;font-weight:700;color:#854d0e">
      🏥 Nouvelle candidature pharmacie reçue — à traiter sous 24h
    </div>
    <div style="font-size:14px;color:#333;line-height:1.8;white-space:pre-wrap;font-family:monospace;background:#f8f8f8;border-radius:10px;padding:16px">
Pharmacie   : ${o.pharmacy_nom || '—'}
Adresse     : ${o.adresse || '—'}
Titulaire   : ${o.patient_nom || '—'}
${o.medicaments || ''}
    </div>
    <p style="font-size:12px;color:#999;margin-top:20px">Reçu le ${date} · Dossier stocké dans la table <code>pharmacy_applications</code> (Dashboard Supabase → Table Editor).</p>
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
      Conservez cet email comme justificatif. Pour toute question : <a href="mailto:administratif@livraisante.fr" style="color:#0D0E09">administratif@livraisante.fr</a>
    </p>
  </div>
  <div style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:12px;color:#999">
    © Livraisanté SAS · RCS Lyon 933 484 917 · 1 Rue des Vergers, 69120 Vaulx-en-Velin
  </div>
</div>`;
}
