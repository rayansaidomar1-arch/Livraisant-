// Web Push (VAPID + chiffrement AES-GCM RFC 8291) — remplace supabase/functions/send-push
// Porté de Deno vers Node.js (crypto.subtle natif depuis Node 20, disponible globalement).
// push_subscriptions reste sur Supabase (architecture hybride) : lecture/suppression
// via lib/supabaseDb.js, pas via Prisma (qui ne connaît que la base Clever Cloud).
const { getPushSubscriptions, deletePushSubscription } = require('./supabaseDb');

const subtle = globalThis.crypto.subtle;

function b64urlEncode(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

function concatArrays(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function buildVapidHeaders(endpoint, vapidPublic, vapidPrivate, subject) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 3600;

  const header = b64urlEncode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64urlEncode(Buffer.from(JSON.stringify({ aud: audience, exp, sub: subject })));
  const unsigned = `${header}.${payload}`;

  const privBytes = b64urlDecode(vapidPrivate);
  const key = await subtle.importKey('raw', privBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const sigB64 = b64urlEncode(new Uint8Array(sig));

  return {
    'Authorization': `vapid t=${unsigned}.${sigB64},k=${vapidPublic}`,
    'Content-Type': 'application/octet-stream',
    'TTL': '86400',
  };
}

async function encryptPayload(subscription, payload) {
  const payloadBytes = new TextEncoder().encode(payload);
  const clientPublicKeyBytes = b64urlDecode(subscription.p256dh);
  const authBytes = b64urlDecode(subscription.auth);

  const serverKeyPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const serverPublicKeyRaw = new Uint8Array(await subtle.exportKey('raw', serverKeyPair.publicKey));
  const clientPublicKey = await subtle.importKey('raw', clientPublicKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  const sharedBits = await subtle.deriveBits({ name: 'ECDH', public: clientPublicKey }, serverKeyPair.privateKey, 256);
  const salt = require('crypto').randomBytes(16);

  const prk = await subtle.importKey('raw', new Uint8Array(sharedBits), 'HKDF', false, ['deriveKey', 'deriveBits']);

  const authInfo = new TextEncoder().encode('Content-Encoding: auth\0');
  const authBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authBytes, info: authInfo }, prk, 256);

  const keyInfo = concatArrays(new TextEncoder().encode('Content-Encoding: aesgcm\x00\x01'), clientPublicKeyBytes, serverPublicKeyRaw);
  const cekKey = await subtle.importKey('raw', new Uint8Array(authBits), 'HKDF', false, ['deriveBits']);
  const cekBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: keyInfo }, cekKey, 128);
  const cek = await subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);

  const nonceInfo = concatArrays(new TextEncoder().encode('Content-Encoding: nonce\x00\x01'), clientPublicKeyBytes, serverPublicKeyRaw);
  const nonceBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, cekKey, 96);

  const paddedPayload = new Uint8Array([0, 0, ...payloadBytes]);
  const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(nonceBits) }, cek, paddedPayload);

  return { encrypted: new Uint8Array(encrypted), salt, serverPublicKey: serverPublicKeyRaw };
}

/**
 * Envoie une notification push à toutes les souscriptions d'un utilisateur.
 * @returns {Promise<{sent:number}>}
 */
async function sendPushToUser(userId, { title, body, url = '/', tag = 'commande' }) {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:administratif@livraisante.fr';

  const subs = await getPushSubscriptions(userId);
  if (!subs.length) return { sent: 0 };

  const payload = JSON.stringify({ title, body, url, tag });
  let sent = 0;

  for (const sub of subs) {
    try {
      const { encrypted, salt, serverPublicKey } = await encryptPayload({ p256dh: sub.p256dh, auth: sub.auth }, payload);
      const vapidHeaders = await buildVapidHeaders(sub.endpoint, vapidPublic, vapidPrivate, vapidSubject);

      const salt64 = b64urlEncode(salt);
      const spk64 = b64urlEncode(serverPublicKey);

      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          ...vapidHeaders,
          'Encryption': `salt=${salt64}`,
          'Crypto-Key': `dh=${spk64};${vapidHeaders['Authorization'].split(',')[1]}`,
        },
        body: encrypted,
      });

      if (res.status === 410 || res.status === 404) {
        await deletePushSubscription(sub.id);
      } else if (res.ok || res.status === 201) {
        sent++;
      }
    } catch (err) {
      console.error('Push failed for sub', sub.id, err.message);
    }
  }

  return { sent };
}

module.exports = { sendPushToUser };
