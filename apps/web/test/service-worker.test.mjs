import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const source=await readFile(new URL('../src/service-worker.js',import.meta.url),'utf8');
function fixture(){
  const listeners={},deleted=[],cached=[];
  const html=new Response('<main>offline shell</main>');
  const cache={match:async url=>url==='/'?html:undefined,addAll:async items=>{cached.push(...items);}};
  runInNewContext(source,{CACHE_NAME:'greenchain-shell-new',ASSETS:['/','/icons/icon-192.png','/_next/static/app.js'],
    URL,Request:class{constructor(url,options){return new Request(new URL(url,'https://demo.example'),options);}},Response,AbortController,setTimeout,clearTimeout,
    fetch:async()=>{throw new Error('network unavailable');},
    caches:{open:async()=>cache,keys:async()=>['greenchain-shell-old','unrelated-cache'],delete:async name=>{deleted.push(name);}},
    self:{location:{origin:'https://demo.example'},clients:{claim:async()=>{}},addEventListener:(type,handler)=>{listeners[type]=handler;},skipWaiting:()=>{}}
  });
  return {listeners,deleted,cached};
}
test('offline navigation returns the installed shell',async()=>{
  const f=fixture();let response;
  f.listeners.fetch({request:{url:'https://demo.example/',method:'GET',mode:'navigate'},respondWith:value=>{response=value;}});
  assert.match(await(await response).text(),/offline shell/);
});
test('API, session responses, cross-origin requests and writes are never cached',()=>{
  const f=fixture();
  for(const request of [
    {url:'https://demo.example/api/v1/session',method:'GET',mode:'cors'},
    {url:'https://api.example/api/v1/captures',method:'GET',mode:'cors'},
    {url:'https://demo.example/',method:'POST',mode:'navigate'},
  ])f.listeners.fetch({request,respondWith:()=>{assert.fail('Private request intercepted');}});
});
test('install precaches assets and activation removes only obsolete GreenChain shells',async()=>{
  const f=fixture();let pending;
  f.listeners.install({waitUntil:value=>{pending=value;}});await pending;
  assert.equal(f.cached.length,3);
  f.listeners.activate({waitUntil:value=>{pending=value;}});await pending;
  assert.deepEqual(f.deleted,['greenchain-shell-old']);
});
