const CACHE_NAME = "compartilhar-projetos-v1";
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/style.css", 
  "/script.js", 
  "/offline.html"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Ignora requisições dinâmicas para o Firebase e Worker
  if (event.request.url.includes("firebaseio.com") || 
      event.request.url.includes("googleapis.com") || 
      event.request.url.includes("api.compartilhar-projetos.com.br")) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse; // Retorna da memória instantaneamente
      }
      return fetch(event.request).then((networkResponse) => {
        return networkResponse;
      });
    }).catch(() => {
        // Fallback offline genérico se a rede falhar
        if (event.request.mode === "navigate") {
            return caches.match("/offline.html");
        }
    })
  );
});
