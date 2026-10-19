import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base='http://localhost:4000/api/v1',origin='http://localhost:3000';
const password=(await readFile(new URL('../.local/presenter-password.txt',import.meta.url),'utf8')).trim();
const login=await fetch(base+'/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({account:'presenter',password})});assert.equal(login.status,200);
const session=await login.json(),cookie=login.headers.getSetCookie()[0].split(';')[0],headers={origin,cookie,'x-csrf-token':session.csrf};
async function call(path){const r=await fetch(base+path,{headers});assert.equal(r.status,200);return r.json();}
try{
  const list=await call('/captures');let found;
  for(const c of list.captures){const id=c.event_id??c.eventId;const inventory=await call(`/cases/${id}/demo-issuance`);if(inventory.batch){found={id,inventory};break;}}
  assert.ok(found,'An issued demo case is available');
  for(let i=0;i<20&&!found.inventory.proof;i++){await new Promise(r=>setTimeout(r,500));found.inventory=await call(`/cases/${found.id}/demo-issuance`);}
  const detail=await call(`/cases/${found.id}/audit`),proof=found.inventory.proof;
  assert.equal(detail.audit.status,'VERIFIED');assert.ok(BigInt(detail.audit.sequence)>0n);assert.equal(detail.audit.pending,0);
  assert.ok(proof);assert.match(proof.commitment,/^[a-f0-9]{64}$/);assert.match(proof.anchor_hash,/^[a-f0-9]{64}$/);assert.ok(BigInt(proof.anchor_seq)>0n);
  assert.ok(detail.events.every(e=>e.chain_seq));assert.equal(new Set(detail.events.map(e=>e.id)).size,detail.events.length);
  const denied=await fetch(base+`/cases/${found.id}/audit`);assert.equal(denied.status,401);
  console.log(JSON.stringify({audit:detail.audit.status,committedEvents:detail.audit.sequence,legacyBackfilled:detail.audit.legacyBackfilled,caseEvents:detail.events.length,proofStatus:found.inventory.proofStatus,commitmentQueued:Boolean(proof),privateReadProtected:true}));
}finally{await fetch(base+'/session',{method:'DELETE',headers});}
