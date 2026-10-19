// Service worker for the fire page. Only active in a secure context (HTTPS or localhost): on plain HTTP the browser
// never installs it and the page behaves exactly as before. What it does:
//   - caches the page shell (/fire, scripts, CSS) so the page OPENS with the server down;
//   - keeps the last /api/fire answer so the register the device last saw is shown (the page labels it as cached);
//   - never caches writes. Queued SAFE/MISSING ticks are kept and replayed by fire.js itself (localStorage), because
//     they must also survive the page being closed and the browser having no Background Sync.
const VERSION = 'signin-sw-v4.0';
const SHELL = ['/fire', '/fire.js', '/shared.js', '/style.css', '/favicon.svg'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET') return;
    if (url.pathname === '/api/fire') {
        // network first; the last good answer is the offline fallback, marked so the page can say so
        e.respondWith(fetch(e.request).then(res => { caches.open(VERSION).then(c => c.put(e.request, res.clone())); return res; })
            .catch(async () => { const hit = await caches.match(e.request); if (!hit) return new Response(JSON.stringify({ error: 'offline, nothing cached' }), { status: 503, headers: { 'Content-Type': 'application/json' } }); const body = await hit.json(); return new Response(JSON.stringify({ ...body, cachedBySw: true }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }));
        return;
    }
    if (SHELL.includes(url.pathname) || url.pathname === '/rollcall') {
        e.respondWith(fetch(e.request).then(res => { caches.open(VERSION).then(c => c.put(e.request, res.clone())); return res; }).catch(() => caches.match(url.pathname === '/rollcall' ? '/fire' : e.request)));
    }
});
