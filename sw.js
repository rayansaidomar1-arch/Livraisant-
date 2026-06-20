/* Livraisanté — service worker (cache de l'app shell pour le mode hors-ligne) */
const CACHE = 'livraisante-v89';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/js/supabase-client.js',
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
