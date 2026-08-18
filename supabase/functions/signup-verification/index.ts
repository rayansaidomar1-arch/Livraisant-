// Supabase Edge Function — signup-verification
// Deploy: supabase functions deploy signup-verification
// Required env vars:
//   SUPABASE_URL        — auto-injecté par Supabase
//   SERVICE_ROLE_KEY    — nécessaire pour lire/écrire `signup_verifications` (RLS fermée)
//
// ── Correctif audit 2026-08-05 (Critique #3) ────────────────────────────────
// Remplace l'ancienne « vérification en 2 étapes » à l'inscription (index.html,
// generateCode()/confirmVerification()), qui générait un code côté client sans
// jamais l'envoyer nulle part, puis comparait la saisie de l'utilisateur à ce
// même code conservé en mémoire côté client — trivialement lisible/contournable
// via les DevTools. Cette fonction envoie un vrai code par email (Resend, via
// `send-email`) avant la création du compte, et le vérifie côté serveur.
//
// Pas de vérification SMS : aucun fournisseur SMS n'existe dans ce projet.
//
// POST { action:'send',   email }              → envoie un code à 6 chiffres
// POST { action:'verify', email, code }        → vérifie le code
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://www.livraisante.fr',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^[0-9]{6}$/;
const CODE_TTL_SECONDS = 10 * 60;

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SERVICE_ROLE_KEY')!;
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

  try {
    const { action, email: rawEmail, code } = await req.json();
    const email = String(rawEmail || '').trim().toLowerCase();

    if (!EMAIL_RE.test(email)) {
      return new Response(JSON.stringify({ error: 'Adresse email invalide' }), { status: 400, headers: corsHeaders });
    }

    if (action === 'send') {
      // Rate-limiting (protection en profondeur — voir migration 20260723000002) :
      // par IP (anti-script) et par email cible (anti-spam d'une même boîte).
      const { data: ipAllowed } = await supabaseAdmin.rpc('check_rate_limit', {
        p_bucket: `signup-verification-send-ip:${ip}`, p_max_hits: 10, p_window_seconds: 3600,
      });
      if (ipAllowed === false) {
        return new Response(JSON.stringify({ error: 'Trop de requêtes, réessayez plus tard.' }), { status: 429, headers: corsHeaders });
      }
      const { data: emailAllowed } = await supabaseAdmin.rpc('check_rate_limit', {
        p_bucket: `signup-verification-send-email:${email}`, p_max_hits: 3, p_window_seconds: 600,
      });
      if (emailAllowed === false) {
        return new Response(JSON.stringify({ error: 'Un code a déjà été envoyé récemment à cette adresse.' }), { status: 429, headers: corsHeaders });
      }

      try { await supabaseAdmin.rpc('cleanup_expired_signup_verifications'); } catch (_e) { /* best-effort */ }

      const arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      const plainCode = String(arr[0] % 1000000).padStart(6, '0');
      const codeHash = await sha256Hex(plainCode);
      const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();

      const { error: upsertErr } = await supabaseAdmin.from('signup_verifications')
        .upsert({ email, code_hash: codeHash, expires_at: expiresAt, attempts: 0, verified_at: null }, { onConflict: 'email' });
      if (upsertErr) {
        return new Response(JSON.stringify({ error: upsertErr.message }), { status: 500, headers: corsHeaders });
      }

      const { error: emailErr } = await supabaseAdmin.functions.invoke('send-email', {
        body: { type: 'signup_verification', to: email, order: { code: plainCode } },
      });
      if (emailErr) {
        return new Response(JSON.stringify({ error: "Échec de l'envoi de l'email" }), { status: 502, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ sent: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'verify') {
      if (!CODE_RE.test(String(code || ''))) {
        return new Response(JSON.stringify({ ok: false, error: 'Code invalide' }), { status: 400, headers: corsHeaders });
      }
      const { data: verifyAllowed } = await supabaseAdmin.rpc('check_rate_limit', {
        p_bucket: `signup-verification-verify:${email}`, p_max_hits: 10, p_window_seconds: 600,
      });
      if (verifyAllowed === false) {
        return new Response(JSON.stringify({ ok: false, error: 'Trop de tentatives, réessayez plus tard.' }), { status: 429, headers: corsHeaders });
      }

      const { data: row } = await supabaseAdmin.from('signup_verifications').select('*').eq('email', email).maybeSingle();
      if (!row || new Date(row.expires_at).getTime() < Date.now()) {
        return new Response(JSON.stringify({ ok: false, error: 'Code expiré, demandez-en un nouveau.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (row.attempts >= 5) {
        return new Response(JSON.stringify({ ok: false, error: 'Trop de tentatives, demandez un nouveau code.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const submittedHash = await sha256Hex(String(code));
      if (!timingSafeEqual(submittedHash, row.code_hash)) {
        await supabaseAdmin.from('signup_verifications').update({ attempts: row.attempts + 1 }).eq('email', email);
        return new Response(JSON.stringify({ ok: false, error: 'Code incorrect.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      await supabaseAdmin.from('signup_verifications').update({ verified_at: new Date().toISOString() }).eq('email', email);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'action inconnue' }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
});
