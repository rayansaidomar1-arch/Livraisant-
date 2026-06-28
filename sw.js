/* Livraisanté — service worker (cache de l'app shell pour le mode hors-ligne) */
const CACHE = 'livraisante-v106';
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

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Ne pas intercepter les requêtes Supabase (auth, API)
  if (url.hostname.includes('supabase.co') || url.hostname.includes('jsdelivr.net')) return;

  // Navigation directe / refresh sur une URL de route (ex. /sante, /livreur/inscription)
  // → toujours servir index.html depuis le cache (SPA History API)
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match('/index.html').then(c => c || fetch('/index.html'))
    );
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
