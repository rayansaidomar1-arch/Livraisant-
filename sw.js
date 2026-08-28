/* Livraisanté — service worker (cache de l'app shell pour le mode hors-ligne) */
const CACHE = 'livraisante-v126';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/js/supabase-client.js',
  '/js/config.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Push notifications ────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'Livraisanté', body: 'Mise à jour de votre commande', url: '/' };
  try { data = { ...data, ...e.data?.json() }; } catch(_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'livraison',
      renotify: true,
      data: { url: data.url }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  // Sécurité : n'autoriser que les URL relatives (commence par /) pour éviter l'open redirect
  const raw = e.notification.data?.url || '/';
  const url = (typeof raw === 'string' && raw.startsWith('/')) ? raw : '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus().then(c => c.navigate(url));
      return clients.openWindow(url);
    })
  );
});

// ── Stratégie de cache ────────────────────────────────────────────
//
// L'app shell (index.html, js/config.js, js/supabase-client.js) était servie en
// « cache d'abord, sans jamais revalider » : une fois `caches.match()` positif,
// le réseau n'était plus jamais consulté. Le contenu ne pouvait donc changer
// qu'en incrémentant CACHE à la main — et cette incrémentation a été oubliée
// sur trois déploiements d'affilée (nouvelle clé VAPID, correctif inscription,
// correctif push). Résultat : les visiteurs déjà venus restaient figés sur la
// version d'avant le 2026-08-24, avec l'ANCIENNE clé publique VAPID, et aucun
// correctif ne les atteignait.
//
// On passe donc l'app shell en « stale-while-revalidate » : réponse immédiate
// depuis le cache (l'index fait ~950 Ko, on ne veut pas attendre le réseau),
// mise à jour en arrière-plan. Une version au plus de retard, convergence
// automatique, sans dépendre d'un geste manuel. Les binaires immuables
// (icônes, images, polices) restent en cache d'abord.
const SHELL_LIKE = /\.(?:html|js|json|css)$/;

function staleWhileRevalidate(request) {
  // `cache: 'no-cache'` est indispensable : le serveur statique renvoie
  // `max-age=31536000` sur les .js (politique par défaut de Static Web Server,
  // et clevercloud/httpserver.json n'est pas lu par ce runtime). Sans cela, la
  // revalidation serait elle-même servie par le cache HTTP du navigateur et ne
  // verrait jamais la nouvelle version. 'no-cache' force un aller-retour
  // conditionnel — un 304 si rien n'a changé, donc quasi gratuit.
  const revalidation = new Request(request.url, { cache: 'no-cache', credentials: 'same-origin' });
  return caches.match(request).then(cached => {
    const network = fetch(revalidation).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy));
      }
      return res;
    }).catch(() => cached);
    // Servir le cache tout de suite s'il existe, sinon attendre le réseau.
    return cached || network;
  });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Ne pas intercepter les requêtes Supabase (auth, API)
  if (url.hostname.includes('supabase.co') || url.hostname.includes('jsdelivr.net')) return;

  // Navigation directe / refresh sur une URL de route (ex. /sante, /livreur/inscription)
  // → servir index.html (SPA History API), en le revalidant en arrière-plan.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      staleWhileRevalidate(new Request('/index.html'))
        .then(r => r || caches.match('/index.html'))
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  if (url.origin === self.location.origin && SHELL_LIKE.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
