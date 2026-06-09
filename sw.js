/* Livraisanté — service worker (cache de l'app shell pour le mode hors-ligne) */
const CACHE = 'livraisante-v46';
const SHELL = [
  '.',
  'index.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png'
];

/* Extensions et chemins à ne jamais mettre en cache (données dynamiques / sensibles) */
const NO_CACHE = [
  /\?action=/,
  /localStorage/,
  /\/api\//
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
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

  const url = e.request.url;
  const isShell = SHELL.some(s => url.endsWith(s));
  const isDynamic = NO_CACHE.some(re => re.test(url));

  /* Stratégie Network-first pour les requêtes dynamiques */
  if (isDynamic) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('index.html'))
    );
    return;
  }

  /* Stratégie Cache-first pour l'app shell, Network-first pour le reste */
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached && isShell) return cached;
      return fetch(e.request).then(res => {
        /* Ne mettre en cache que les ressources statiques de même origine */
        if (res.ok && new URL(url).origin === self.location.origin && !isDynamic) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached || caches.match('index.html'));
    })
  );
});
