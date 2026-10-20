// Moe Wiggly Studio · service worker (funciona sin conexión)
// Si cambias algún archivo, sube también el número de versión para que los móviles se actualicen.
const C='moe-wiggly-v7',F=['./','index.html','manifest.webmanifest','icon-512.png','online.js','online-config.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.all(F.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;
 if(new URL(e.request.url).origin!==location.origin)return; // nunca cachear Supabase ni la CDN: datos privados de las salas
 e.respondWith(fetch(e.request).then(n=>{if(n.ok){const cp=n.clone();caches.open(C).then(c=>c.put(e.request,cp))}return n}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('index.html'))))});
