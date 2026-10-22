import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
// The presentation path of docs/22 §11 against the running local demo (npm run demo:local): browse, order, allocation
// explanation, pay, replay the callback with an unchanged ledger, then the market invariant report. Writes one demo order.
const base='http://localhost:4000/api/v1',origin='http://localhost:3000';
const secret=async name=>(await readFile(new URL(`../.local/${name}`,import.meta.url),'utf8')).trim();
async function signIn(account,password){
  const r=await fetch(base+'/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({account,password})});assert.equal(r.status,200,`${account} sign-in`);
  const session=await r.json();return {origin,cookie:r.headers.getSetCookie()[0].split(';')[0],'x-csrf-token':session.csrf};
}
const buyer=await signIn('buyer',await secret('buyer-password.txt')),presenter=await signIn('presenter',await secret('presenter-password.txt'));
async function call(headers,path,body,expected=200){
  const r=await fetch(base+path,body===undefined?{headers}:{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(r.status,expected,`${path}: ${r.status}`);return r.json();
}
const label='Demonstration — synthetic credits and simulated payments';
try{
  const inventory=await call(buyer,'/market/inventory');
  assert.equal(inventory.label,label);assert.ok(inventory.available>=2,'the demo market has credits left');assert.ok(inventory.unitPricePaise,'a price is configured');
  const quantity=2,quotedTotalPaise=String(BigInt(inventory.unitPricePaise)*BigInt(quantity));
  const order=await call(buyer,'/orders',{requestId:randomUUID(),quantity,quotedTotalPaise},201);
  assert.equal(order.order.state,'RESERVED');assert.equal(order.label,label);assert.equal(order.priceChangedFromQuote,false);
  assert.ok(order.allocation.groups.length>0&&order.allocation.groups.every(g=>/^Group [0-9A-F]{6}$/.test(g.group)),'the allocation is explained by pseudonymous group');
  const id=order.order.id;
  await call(buyer,`/orders/${id}/payment-attempts`,{acceptSnapshotHash:order.snapshotHash});
  assert.equal((await call(presenter,`/demo/orders/${id}/simulate`,{outcome:'success'})).outcome,'FULFILLED');
  const paid=await call(buyer,`/orders/${id}`);
  assert.equal(paid.order.state,'FULFILLED');assert.equal(paid.purchased.length,quantity);
  const replay=await call(presenter,`/demo/orders/${id}/simulate`,{outcome:'replay'});
  assert.deepEqual([replay.outcome,replay.replayed],['FULFILLED',true],'the same callback again is a replay');
  const after=await call(buyer,`/orders/${id}`);
  assert.deepEqual(after.purchased,paid.purchased,'the replayed callback left the ledger unchanged');
  const report=await call(presenter,'/demo/invariants');
  console.log(JSON.stringify({order:id,state:after.order.state,credits:after.purchased.length,payablePaise:after.order.payablePaise,
    allocation:after.allocation.groups.map(g=>`${g.group}×${g.count}`),replayUnchangedLedger:true,invariantViolations:report.violations}));
  assert.deepEqual(report.violations,[],'market invariants hold');
}finally{for(const headers of [buyer,presenter])await fetch(base+'/session',{method:'DELETE',headers});}
