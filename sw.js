// Offline cache for the installed app. Network first, so a new version shows up on the next
// online launch; the cache is the fallback when there is no connection.
const CACHE = 'uke-monsters-v3';   // monster sprites are cached on first view (network first)
const ASSETS = [
  './', 'index.html', 'grader.js', 'tuner.js', 'manifest.json', 'monster.webp',
  'expressions/idle.webp', 'expressions/play.webp', 'expressions/listen.webp',
  'expressions/cheer.webp', 'expressions/tryagain.webp', 'expressions/goodbye.webp', 'expressions/tune.webp',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.map(a => c.add(a).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
