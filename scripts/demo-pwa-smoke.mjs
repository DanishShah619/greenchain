import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base='http://127.0.0.1:3000';
const shell=await fetch(base+'/');assert.equal(shell.status,200);
const worker=await fetch(base+'/sw.js');assert.equal(worker.status,200);
const source=await worker.text(),local=await readFile(new URL('../apps/web/out/sw.js',import.meta.url),'utf8');assert.equal(source,local,'Preview serves the current generated worker');
const assets=JSON.parse(source.match(/^const ASSETS=(.*);$/m)[1]);let foundHistory=false;
for(const asset of assets){const response=await fetch(base+asset);assert.equal(response.status,200,asset);if(asset.endsWith('.js')&&(await response.text()).includes('Case transaction history'))foundHistory=true;}
assert.ok(foundHistory,'Built case history UI is served');
const health=await fetch('http://127.0.0.1:4000/api/v1/health');assert.equal(health.status,200);assert.equal((await health.json()).status,'ready');
console.log(JSON.stringify({web:'ready',api:'ready',precacheAssets:assets.length,currentWorker:true,caseHistoryUI:true}));
