// Botica do Poker - Service Worker
const CACHE = 'botica-v2';
const ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting(); // Ativa o novo SW imediatamente, sem esperar
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // Assume controle de todas as abas abertas imediatamente
  );
});

// Network-first: sempre tenta buscar a versão mais nova primeiro.
// Só usa cache se estiver completamente offline.
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then(response => {
        // Atualiza o cache com a versão mais recente
        const responseClone = response.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, responseClone));
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
