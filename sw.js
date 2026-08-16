// Botica do Poker - Service Worker
const CACHE = 'botica-v3';
const ASSETS = ['./', './index.html', './manifest.json'];

// Push notification (timer de blinds) — isolado em try/catch pra um
// navegador sem suporte a mensagens nunca derrubar o service worker
// inteiro (o cache/fetch abaixo tem que continuar funcionando mesmo
// se isso falhar).
try {
  importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js');

  firebase.initializeApp({
    apiKey: "AIzaSyACviy1MMQadWQb0FQNzRReuaSvXALYzC0",
    authDomain: "home-game-14a59.firebaseapp.com",
    databaseURL: "https://home-game-14a59-default-rtdb.firebaseio.com",
    projectId: "home-game-14a59",
    storageBucket: "home-game-14a59.firebasestorage.app",
    messagingSenderId: "1013527680343",
    appId: "1:1013527680343:web:3ca848403d3be3cb2c5a12"
  });

  const messaging = firebase.messaging();

  // Payload vem só em "data" (não "notification") de propósito — evita
  // notificação duplicada que alguns navegadores mostram sozinhos quando
  // o payload tem "notification". Aqui a gente decide e mostra na mão.
  messaging.onBackgroundMessage(function(payload) {
    var titulo = (payload.data && payload.data.title) || 'Botica do Poker';
    var corpo = (payload.data && payload.data.body) || '';
    self.registration.showNotification(titulo, {
      body: corpo,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: 'botica-blind-timer'
    });
  });
} catch (e) {
  console.log('Push messaging não disponível:', e);
}

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if ('focus' in clientList[i]) return clientList[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

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
