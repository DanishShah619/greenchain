/* CACHE_NAME and ASSETS are injected from the static export at build time. */
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS.map(url=>new Request(url,{cache:'reload'})))));
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const name of await caches.keys())if(name.startsWith('greenchain-shell-')&&name!==CACHE_NAME)await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting();
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  // The cache contains only the public static shell, never session/API responses.
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(event.request.mode==='navigate'&&url.pathname==='/'){
    event.respondWith((async()=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
      try{const response=await fetch(event.request,{signal:controller.signal});if(response.ok)return response;}
      catch{}finally{clearTimeout(timer);}
      return (await (await caches.open(CACHE_NAME)).match('/'))||Response.error();
    })());
    return;
  }
  if(ASSETS.includes(url.pathname))event.respondWith((async()=>{
    const cached=await (await caches.open(CACHE_NAME)).match(url.pathname);
    return cached||fetch(event.request);
  })());
});
