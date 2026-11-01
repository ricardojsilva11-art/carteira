/* Carteira — notificações (sem cache: a app vem sempre da rede) */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(x){ d = {title:"Carteira", body:e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(d.title || "Carteira", {
    body:d.body || "", tag:d.tag || undefined, renotify:!!d.tag, data:{url:d.url || "./"},
    icon:"icon-180.png", badge:"icon-180.png"
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const alvo = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const lista = await self.clients.matchAll({type:"window", includeUncontrolled:true});
    for (const c of lista){ if (c.url.startsWith(self.registration.scope)){ await c.focus(); try{ await c.navigate(alvo); }catch(x){} return; } }
    await self.clients.openWindow(alvo);
  })());
});
