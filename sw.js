// FORÇA A DESINSTALAÇÃO E LIMPEZA DE CACHE
self.addEventListener('install', (event) => {
  // Pula a fila e ativa imediatamente
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // Pega todos os caches antigos salvos no celular
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Deleta todos sem exceção
          return caches.delete(cacheName);
        })
      );
    }).then(() => {
      // Desinstala o Service Worker permanentemente
      self.registration.unregister();
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Ignora todas as interceptações de rede e deixa o app/site seguir o fluxo normal da web
  return;
});
