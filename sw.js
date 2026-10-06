const CACHE_NAME = 'compartilhar-projetos-v2';

// Ficheiros essenciais para guardar logo de início
const ASSETS_TO_CACHE = [
  '/',
  '/index.html'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // Ativa imediatamente a nova versão
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Apaga apenas os caches velhos (ex: v1, kamikaze antigo, etc)
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Ignora requisições que não sejam GET (como POST de formulários/API)
  if (event.request.method !== 'GET') return;
  
  // Ignora extensões do Chrome e ferramentas
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    // TENTA IR À INTERNET PRIMEIRO (Para garantir que tem a versão mais recente)
    fetch(event.request)
      .then((networkResponse) => {
        // Se a internet funcionou e a resposta for válida, guarda no cache para o futuro
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // SE A INTERNET FALHAR (Caiu o sinal), SERVE O CACHE SILENCIOSAMENTE
        return caches.match(event.request);
      })
  );
});
