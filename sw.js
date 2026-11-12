importScripts('./version.js');

const CACHE = `fpv-log-${self.APP_VERSION}-${self.APP_BUILD}`;
const ASSETS = [
  './',
  './index.html',
  './version.js',
  './manifest.webmanifest',
  './demo.json',
  './starter.json',
  './css/app.css',
  './css/topo.svg',
  './css/topo-light.svg',
  './css/lines.svg',
  './css/lines-acc.svg',
  './js/app.js',
  './js/config.js',
  './js/db.js',
  './js/sync.js',
  './js/google-token.js',
  './js/ui.js',
  './js/i18n.js',
  './js/ru.js',
  './js/photos.js',
  './js/usd.js',
  './js/usd-rates.js',
  './js/changelog.js',
  './js/fcconfig.js',
  './js/vendor/qrcode.js',
  './js/weather.js',
  './js/releases.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// Файли — повз HTTP-кеш браузера: GitHub Pages віддає max-age=600, і без reload
// оновлення 10 хвилин після релізу ставило б старі файли.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Лише свої старі версії: на vitaliylobko.github.io поруч живуть інші застосунки зі своїми кешами
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('fpv-log-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// «Поділитися» → FPV Log (share_target у manifest): картинку — у кеш, застосунок забере її за ?go=shared.
// Кеш свій за назвою: на тому ж origin живе shooting-log зі своїм «shared-image»
async function receiveShare(request) {
  try {
    const file = (await request.formData()).get('image');
    if (file) await (await caches.open('fpv-log:shared-image')).put('shared', new Response(file, { headers: { 'Content-Type': file.type || 'image/jpeg' } }));
  } catch { /* не вийшло — застосунок просто відкриється */ }
  return Response.redirect(new URL('?go=shared', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method === 'POST' && new URL(request.url).searchParams.get('go') === 'shared') {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    // Лише свій кеш: caches.match шукав би й у новішій версії, що вже встановилась, але ще не активна
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (err) {
      if (request.mode === 'navigate') return cache.match('./index.html');
      throw err;
    }
  })());
});
