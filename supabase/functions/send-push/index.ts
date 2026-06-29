// Supabase Edge Function — send-push
// Envoie des notifications Web Push à un utilisateur
// Appelé par stripe-webhook et par le dashboard pharmacie
// Required env vars:
//   VAPID_PUBLIC_KEY   — clé publique VAPID (aussi dans config.js)
//   VAPID_PRIVATE_KEY  — clé privée VAPID (jamais exposée côté client)
//   VAPID_SUBJECT      — mailto:contact@livraisante.fr
//   SERVICE_ROLE_KEY   — pour lire push_subscriptions sans RLS

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── VAPID signature (Web Push Protocol) ──────────────────────────────
async function buildVapidHeaders(endpoint: string, vapidPublic: string, vapidPrivate: string, subject: string) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 3600;

  const header = btoa(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = btoa(JSON.stringify({ aud: audience, exp, sub: subject })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsigned = `${header}.${payload}`;

  const privBytes = Uint8Array.from(atob(vapidPrivate.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', privBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return {
    'Authorization': `vapid t=${unsigned}.${sigB64},k=${vapidPublic}`,
    'Content-Type': 'application/octet-stream',
    'TTL': '86400',
  };
}

// ── Chiffrement AES-GCM (Web Push encryption RFC 8291) ───────────────
async function encryptPayload(subscription: { p256dh: string; auth: string }, payload: string) {
  const payloadBytes = new TextEncoder().encode(payload);

  const clientPublicKeyBytes = Uint8Array.from(atob(subscription.p256dh.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  const authBytes = Uint8Array.from(atob(subscription.auth.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));

  // Server ephemeral key pair
  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const serverPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeyPair.publicKey));
  const clientPublicKey = await crypto.subtle.importKey('raw', clientPublicKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // ECDH shared secret
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublicKey }, serverKeyPair.privateKey, 256);

  // Salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF extract + expand (simplified for Web Push)
  const prk = await crypto.subtle.importKey('raw', new Uint8Array(sharedBits), 'HKDF', false, ['deriveKey', 'deriveBits']);

  // Auth secret
  const authInfo = new TextEncoder().encode('Content-Encoding: auth\0');
  const authBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authBytes, info: authInfo }, prk, 256
  );

  // Content encryption key
  const keyInfo = concatArrays(new TextEncoder().encode('Content-Encoding: aesgcm\x00\x01'), clientPublicKeyBytes, serverPublicKeyRaw);
  const cekKey = await crypto.subtle.importKey('raw', new Uint8Array(authBits), 'HKDF', false, ['deriveBits']);
  const cekBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: keyInfo }, cekKey, 128);
  const cek = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);

  // Nonce
  const nonceInfo = concatArrays(new TextEncoder().encode('Content-Encoding: nonce\x00\x01'), clientPublicKeyBytes, serverPublicKeyRaw);
  const nonceBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, cekKey, 96);

  // Encrypt
  const paddedPayload = new Uint8Array([0, 0, ...payloadBytes]); // 2-byte padding length = 0
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(nonceBits) }, cek, paddedPayload);

  return { encrypted: new Uint8Array(encrypted), salt, serverPublicKey: serverPublicKeyRaw };
}

function concatArrays(...arrays: Uint8Array[]) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

// ── Main handler ─────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Sécurité : cette fonction est réservée aux appels serveur-à-serveur (service role)
  // Elle ne doit JAMAIS être appelée directement depuis le navigateur
  const authHeader = req.headers.get('authorization') || '';
  const serviceKey = Deno.env.get('SERVICE_ROLE_KEY') || '';
  const supabaseServiceHeader = `Bearer ${serviceKey}`;
  if (!serviceKey || authHeader !== supabaseServiceHeader) {
    console.warn('send-push: unauthorized call attempt');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  try {
    const { user_id, title, body, url = '/' } = await req.json();
    if (!user_id || !title) return new Response(JSON.stringify({ error: 'user_id and title required' }), { status: 400 });

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SERVICE_ROLE_KEY')!);
    const vapidPublic  = Deno.env.get('VAPID_PUBLIC_KEY')!;
    const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY')!;
    const vapidSubject = Deno.env.get('VAPID_SUBJECT') || 'mailto:contact@livraisante.fr';

    // Récupère tous les abonnements de cet utilisateur
    const { data: subs } = await supabase.from('push_subscriptions').select('*').eq('user_id', user_id);
    if (!subs || subs.length === 0) return new Response(JSON.stringify({ sent: 0 }), { headers: corsHeaders });

    const payload = JSON.stringify({ title, body, url, tag: 'commande' });
    let sent = 0;

    for (const sub of subs) {
      try {
        const { encrypted, salt, serverPublicKey } = await encryptPayload({ p256dh: sub.p256dh, auth: sub.auth }, payload);
        const vapidHeaders = await buildVapidHeaders(sub.endpoint, vapidPublic, vapidPrivate, vapidSubject);

        const body64 = btoa(String.fromCharCode(...encrypted));
        const salt64 = btoa(String.fromCharCode(...salt));
        const spk64  = btoa(String.fromCharCode(...serverPublicKey));

        const res = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            ...vapidHeaders,
            'Encryption': `salt=${salt64.replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}`,
            'Crypto-Key': `dh=${spk64.replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')};${vapidHeaders['Authorization'].split(',')[1]}`,
          },
          body: encrypted,
        });

        if (res.status === 410 || res.status === 404) {
          // Abonnement expiré — on le supprime
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        } else if (res.ok || res.status === 201) {
          sent++;
        }
      } catch (err) {
        console.error('Push failed for sub', sub.id, err.message);
      }
    }

    return new Response(JSON.stringify({ sent }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('send-push error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
});
