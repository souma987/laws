const CACHE_NAME = 'laws-pwa-v1';

// Service Workerの配置場所からベースパスを自動取得
const BASE_PATH = self.location.pathname.replace(/\/sw\.js$/, '');

// キャッシュ対象のリソース
const ASSETS_TO_CACHE = [
  `${BASE_PATH}/`,
  `${BASE_PATH}/index.html`,
  `${BASE_PATH}/app.js`,
  `${BASE_PATH}/manifest.json`,
  `${BASE_PATH}/icons/favicon.ico`,
  `${BASE_PATH}/icons/favicon.svg`,
  `${BASE_PATH}/icons/favicon-96x96.png`,
  `${BASE_PATH}/icons/apple-touch-icon.png`,
  `${BASE_PATH}/icons/web-app-manifest-192x192.png`,
  `${BASE_PATH}/icons/web-app-manifest-512x512.png`
];

const CACHE_URLS = new Set(
  ASSETS_TO_CACHE.map((path) => new URL(path, self.location.href).href)
);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  requestUrl.search = '';
  const cleanUrl = requestUrl.href;

  if (!CACHE_URLS.has(cleanUrl)) return;

  event.respondWith(
    caches.match(cleanUrl).then((cachedResponse) => {
      if (cachedResponse) {
        console.log("Cache hit:", cleanUrl);
        return cachedResponse;
      }
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(cleanUrl, responseToCache);
        });
        return response;
      });
    })
  );
});
