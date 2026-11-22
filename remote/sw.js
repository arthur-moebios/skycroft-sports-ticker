/* Service worker do controle Skycroft — cache leve do app shell.
 * Dados (api/*) nunca são cacheados: sempre rede.
 * O shell vai por rede primeiro; o cache só entra quando a rede falha. */
const CACHE = "skycroft-remote-v4";
// As URLs versionadas sao as que a pagina pede; precachear as sem versao
// deixaria o modo offline servindo arquivo que ninguem busca.
const SHELL = ["/remote", "/remote/index.html", "/remote/app.js?v=5", "/remote/style.css?v=5", "/remote/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // nunca cacheia dados ao vivo
  // Rede primeiro, cache como rede de seguranca. Cache-first obrigava a lembrar
  // de versionar o CACHE a cada deploy, e quem esquecesse ficava com JS velho.
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/remote/index.html")))
  );
});
