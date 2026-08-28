// Supabase Edge Function — send-push
// Envoie des notifications Web Push à un utilisateur
// Appelé par stripe-webhook et par le dashboard pharmacie
// Required env vars:
//   VAPID_PUBLIC_KEY   — clé publique VAPID (aussi dans config.js)
//   VAPID_PRIVATE_KEY  — clé privée VAPID (jamais exposée côté client)
//   VAPID_SUBJECT      — mailto:administratif@livraisante.fr
//   SERVICE_ROLE_KEY   — pour lire push_subscriptions sans RLS

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://www.livraisante.fr',
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

  // WebCrypto n'accepte le format 'raw' pour une clé EC que s'il s'agit d'une clé
  // PUBLIQUE : réclamer l'usage 'sign' sur le scalaire privé brut lève
  // « Unsupported key usage for ECDSA key ». L'exception étant avalée par le
  // catch de la boucle d'envoi, aucune notification ne partait jamais et rien ne
  // le signalait. La clé privée passe donc par JWK, dont les coordonnées x/y se
  // relisent dans la clé publique VAPID (65 octets non compressés : 0x04 ‖ x ‖ y).
  const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const pubBytes = Uint8Array.from(atob(vapidPublic.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  if (pubBytes.length !== 65 || pubBytes[0] !== 4) {
    throw new Error(`VAPID_PUBLIC_KEY invalide : ${pubBytes.length} octets, attendu 65 commençant par 0x04`);
  }
  const privBytes = Uint8Array.from(atob(vapidPrivate.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  // Un import JWK échoue si la clé privée n'appartient pas à la clé publique :
  // une paire dépareillée est signalée plutôt que de produire des signatures
  // que les services de push rejetteraient en 401.
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: b64url(pubBytes.subarray(1, 33)),
    y: b64url(pubBytes.subarray(33, 65)),
    d: b64url(privBytes),
    ext: false, key_ops: ['sign'],
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return {
    'Authorization': `vapid t=${unsigned}.${sigB64},k=${vapidPublic}`,
    'Content-Type': 'application/octet-stream',
    // Sans `Content-Encoding`, le service de push ignore comment le corps a été
    // chiffré et rejette l'envoi (Apple : 400 BadWebPushRequest). Le statut
    // n'étant ni 2xx ni 410/404, la boucle n'incrémentait simplement pas `sent`
    // et l'échec ne laissait aucune trace.
    'Content-Encoding': 'aesgcm',
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

// ── Correctif audit sécurité 2026-07-23 (Élevé #3) ───────────────────
// Avant ce correctif : (1) le secret service_role était comparé par simple
// égalité de chaîne JS (`===`), qui s'arrête au premier octet différent —
// donc en théorie mesurable par timing pour deviner le secret octet par octet ;
// (2) aucun des champs `title`/`body`/`url` fournis dans le corps de la requête
// n'était validé (type/longueur), y compris sur le chemin service_role — si
// `SERVICE_ROLE_KEY` fuitait un jour, ou si un appelant interne était compromis,
// rien n'empêchait de pousser un contenu de phishing arbitraire (taille
// illimitée, `url` non contrainte) à n'importe quel utilisateur.
// Fix : comparaison en temps constant pour le secret, + validation stricte du
// contenu (types, longueurs bornées, `url` restreinte à un chemin relatif —
// même contrainte que celle déjà appliquée côté client par `sw.js` au clic).
function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);
  const len = Math.max(aBuf.length, bBuf.length, 32);
  let diff = aBuf.length ^ bBuf.length;
  for (let i = 0; i < len; i++) {
    diff |= (i < aBuf.length ? aBuf[i] : 0) ^ (i < bBuf.length ? bBuf[i] : 0);
  }
  return diff === 0;
}

const MAX_TITLE_LEN = 100;
const MAX_BODY_LEN = 300;
const MAX_URL_LEN = 200;

function validatePushContent(title: unknown, body: unknown, url: unknown): { ok: true; title: string; body: string; url: string } | { ok: false; error: string } {
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LEN) {
    return { ok: false, error: `title invalide (chaîne non vide, max ${MAX_TITLE_LEN} caractères)` };
  }
  if (body !== undefined && body !== null && (typeof body !== 'string' || body.length > MAX_BODY_LEN)) {
    return { ok: false, error: `body invalide (chaîne, max ${MAX_BODY_LEN} caractères)` };
  }
  const rawUrl = url ?? '/';
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_URL_LEN || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
    return { ok: false, error: 'url invalide (doit être un chemin relatif commençant par /)' };
  }
  return { ok: true, title, body: typeof body === 'string' ? body : '', url: rawUrl };
}

// ── Main handler ─────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Auth : service_role (serveur→serveur) OU JWT anon valide (auto-test, envoi à soi-même uniquement)
  const authHeader = req.headers.get('authorization') || '';
  // `SERVICE_ROLE_KEY` est un secret posé à la main ; `SUPABASE_SERVICE_ROLE_KEY`
  // est injectée par la plateforme et suit les rotations de clés. Pour accéder à
  // la base on privilégie celle de la plateforme, toujours à jour, et on retombe
  // sur le secret manuel s'il est seul présent.
  //
  // Mais ce secret sert AUSSI à reconnaître un appelant serveur→serveur. Le jour
  // où l'on y range par erreur une clé publique — ce qui est arrivé : la clé
  // `sb_publishable_…`, publiée dans js/config.js, s'y trouvait — n'importe quel
  // visiteur peut la présenter en `Authorization` et se faire passer pour un
  // appelant interne, donc pousser des notifications à n'importe quel compte.
  // Une clé publique ne doit jamais pouvoir tenir ce rôle : on l'écarte
  // explicitement, au lieu de faire confiance au nom de la variable.
  const looksPrivileged = (k: string): boolean => {
    if (!k) return false;
    if (k.startsWith('sb_publishable_')) return false;      // clé publique par nature
    if (k.startsWith('sb_secret_')) return true;
    if (k.startsWith('eyJ')) {                              // ancien format JWT
      try {
        const claims = JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return claims.role === 'service_role';
      } catch { return false; }
    }
    return false;
  };

  const platformKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const manualKey   = Deno.env.get('SERVICE_ROLE_KEY') || '';
  const candidates  = [platformKey, manualKey].filter(looksPrivileged);
  for (const rejected of [platformKey, manualKey]) {
    if (rejected && !looksPrivileged(rejected)) {
      console.error('send-push: une clé sans privilège est configurée comme clé service_role — ignorée');
    }
  }
  const serviceKey = candidates[0] || '';
  // Comparaison à temps constant, et uniquement contre des clés réellement privilégiées.
  const isServiceRole = candidates.some((k) => timingSafeEqual(authHeader, `Bearer ${k}`));

  try {
    const { user_id, title, body, url = '/' } = await req.json();
    if (!user_id) return new Response(JSON.stringify({ error: 'user_id required' }), { status: 400, headers: corsHeaders });

    const validated = validatePushContent(title, body, url);
    if (!validated.ok) return new Response(JSON.stringify({ error: validated.error }), { status: 400, headers: corsHeaders });

    if (!isServiceRole) {
      // Validation JWT anon : l'utilisateur ne peut pusher qu'à lui-même
      const anonClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
      const { data: { user } } = await anonClient.auth.getUser(authHeader.replace(/^Bearer /, ''));
      if (!user || user.id !== user_id) {
        console.warn('send-push: unauthorized JWT attempt');
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }
    }

    // Un secret absent doit échouer ici, avec un message lisible, plutôt que de
    // se traduire plus bas par une lecture vide indiscernable d'un utilisateur
    // sans abonnement.
    if (!serviceKey) {
      console.error('send-push: aucune clé service_role valide (SUPABASE_SERVICE_ROLE_KEY / SERVICE_ROLE_KEY absentes ou sans privilège)');
      return new Response(JSON.stringify({
        error: 'Aucune clé service_role valide côté serveur : le secret SERVICE_ROLE_KEY doit contenir une clé sb_secret_… (pas la clé publishable).',
      }), { status: 500, headers: corsHeaders });
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);

    // ── Rate-limiting (audit 2026-07-23, Moyen) — clé sur le user_id CIBLE (le
    // destinataire), pas l'appelant : ça borne les dégâts même dans le pire cas
    // (SERVICE_ROLE_KEY qui fuit, cf. Élevé #3 ci-dessus), sans gêner le flux
    // normal (stripe-webhook envoie ~1 push par évènement de commande).
    // En échec (erreur RPC/infra), on n'échoue pas la requête : le rate-limiting
    // est une protection en profondeur, pas la barrière de sécurité principale.
    try {
      const { data: allowed, error: rlErr } = await supabase.rpc('check_rate_limit', {
        p_bucket: `send-push:${user_id}`, p_max_hits: 20, p_window_seconds: 600,
      });
      if (!rlErr && allowed === false) {
        return new Response(JSON.stringify({ error: 'Trop de notifications envoyées, réessayez plus tard.' }), { status: 429, headers: corsHeaders });
      }
    } catch (_e) { /* fail-open volontaire, voir commentaire ci-dessus */ }

    const vapidPublic  = Deno.env.get('VAPID_PUBLIC_KEY')!;
    const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY')!;
    const vapidSubject = Deno.env.get('VAPID_SUBJECT') || 'mailto:administratif@livraisante.fr';

    // Récupère tous les abonnements de cet utilisateur.
    // L'erreur de lecture était ignorée : une clé refusée, une RLS qui mord ou
    // une panne réseau donnaient `subs = null`, donc `{sent:0}` — réponse
    // strictement identique à celle d'un utilisateur sans abonnement. Le vrai
    // motif ne doit plus être confondu avec l'absence d'abonné.
    const { data: subs, error: subsErr } = await supabase
      .from('push_subscriptions').select('*').eq('user_id', user_id);
    if (subsErr) {
      console.error('send-push: lecture de push_subscriptions refusée -', subsErr.code, subsErr.message);
      return new Response(JSON.stringify({ error: `Lecture des abonnements impossible : ${subsErr.message}` }), { status: 500, headers: corsHeaders });
    }
    if (!subs || subs.length === 0) {
      // Une clé sans privilège ne provoque pas d'erreur : PostgREST répond
      // `200 []` parce que la RLS a filtré. « Aucun abonné » et « je n'ai pas le
      // droit de voir les abonnés » sont donc littéralement la même réponse, et
      // le contrôle de `subsErr` ci-dessus ne peut pas les séparer.
      // On lève l'ambiguïté par une opération réservée à service_role : si elle
      // échoue, la lecture précédente n'était pas fiable et le vide observé ne
      // veut rien dire.
      const { error: probeErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (probeErr) {
        console.error('send-push: la clé utilisée n\'a pas les privilèges service_role -', probeErr.message);
        return new Response(JSON.stringify({
          error: 'La fonction n\'a pas les privilèges service_role : les abonnements sont invisibles pour elle. Vérifiez le secret SERVICE_ROLE_KEY.',
        }), { status: 500, headers: corsHeaders });
      }
      return new Response(JSON.stringify({ sent: 0 }), { headers: corsHeaders });
    }

    const payload = JSON.stringify({ title: validated.title, body: validated.body, url: validated.url, tag: 'commande' });
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
            // `Crypto-Key` ne porte que la clé éphémère ECDH ; la clé publique
            // VAPID voyage dans `k=` de `Authorization` (RFC 8292). L'y répéter
            // sous une étiquette que cet en-tête ne définit pas participait au rejet.
            'Crypto-Key': `dh=${spk64.replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}`,
          },
          body: encrypted,
        });

        if (res.status === 410 || res.status === 404) {
          // Abonnement expiré — on le supprime
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        } else if (res.ok || res.status === 201) {
          sent++;
        } else {
          // Ne pas laisser un statut inattendu disparaître sans trace.
          const detail = await res.text().catch(() => '');
          console.error('Push refusé par', new URL(sub.endpoint).host, '-', res.status, detail.slice(0, 200));
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
