import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migratedPglite} from './support/pglite.js';
import {seedMarket,buyer,PRICE,PII_LABEL,PII_VILLAGE} from './support/market.js';
import {acceptPartial,cancelOrder,createOrder,getOrder,listOrders,reapExpired} from '../src/modules/market/application/orders.js';
import {withScenarioLock} from '../src/modules/market/application/lock.js';
import {assertMarketInvariants} from '../src/modules/market/application/invariants.js';
import {chainAudit,verifyAuditFull} from '../src/modules/audit/application/audit.js';
import type {Database} from '../src/kernel/database.js';
const b1=buyer('buyer-1'),b2=buyer('buyer-2');
const order=(db:Database,actor=b1,quantity=2,extra:{requestId?:string;quotedTotalPaise?:string}={})=>createOrder(db,actor,{requestId:extra.requestId??randomUUID(),quantity,...(extra.quotedTotalPaise?{quotedTotalPaise:extra.quotedTotalPaise}:{})});
const code=(c:string)=>(e:any)=>{assert.equal(e?.code,c);return true;};
const credits=async(db:Database,state:string)=>(await db.query('SELECT count(*)::int AS n FROM demo_credits WHERE state=$1',[state])).rows[0].n as number;
const clean=async(db:Database)=>assert.deepEqual(await assertMarketInvariants(db),[]);
async function market(groups:number,perGroup:number,o:{price?:bigint|null;buyers?:string[]}={}){
  const {db}=await migratedPglite();const seed=await seedMarket(db,{groups,perGroup,...o});return {db,seed};
}
test('an order spreads across the longest-waiting groups, reserves exactly its credits and reconciles',async()=>{
  const {db,seed}=await market(20,10);
  const v=await order(db,b1,20);
  assert.equal(v.order.state,'RESERVED');assert.equal(v.order.allocatedQuantity,20);
  assert.equal(v.order.principalPaise,String(PRICE*20n));assert.equal(v.order.payablePaise,v.order.principalPaise);
  assert.equal(v.items.length,20);assert.ok(v.items.every(i=>i.active));
  assert.equal(v.allocation?.cap,3);assert.ok(v.allocation?.groups.every(g=>g.count===1),'round-robin: one credit per group');
  assert.equal(await credits(db,'RESERVED'),20);
  const reservedFor=Date.parse(v.order.reservedUntil!)-Date.parse(v.order.allocatedAt!);assert.equal(reservedFor,300_000);
  // Each group gave its lowest credit id.
  const expected=seed.groups.map(g=>g.creditIds[0]).sort();assert.deepEqual(v.items.map(i=>i.creditId),expected);
  await clean(db);
});
test('a small order goes to the groups that have waited longest',async()=>{
  const {db,seed}=await market(10,10);
  const v=await order(db,b1,1);
  // seedMarket makes group i available i+1 days ago, so the last group has waited longest.
  assert.equal(v.items[0].creditId,seed.groups[9].creditIds[0]);
});
test('buyer responses never contain farmer names, villages or internal case data',async()=>{
  const {db}=await market(5,10);
  const v=await order(db,b1,1),text=JSON.stringify([v,await getOrder(db,b1,v.order.id),await listOrders(db,b1)]);
  assert.doesNotMatch(text,new RegExp(`${PII_LABEL}|${PII_VILLAGE}|area|village|farmer`,'i'));
  assert.match(v.items[0].group,/^Group [0-9A-F]{6}$/);assert.equal(v.namespace,'DEMO_ONLY');
});
test('a request id is idempotent per buyer: replay returns the same order, a different body is KEY_REUSE',async()=>{
  const {db}=await market(20,10);const requestId=randomUUID();
  const first=await order(db,b1,2,{requestId}),again=await order(db,b1,2,{requestId});
  assert.equal(again.order.id,first.order.id);assert.equal(again.replayed,true);assert.equal(await credits(db,'RESERVED'),2);
  await assert.rejects(order(db,b1,3,{requestId}),code('KEY_REUSE'));
  const other=await order(db,b2,2,{requestId});assert.notEqual(other.order.id,first.order.id,'request ids are scoped to the buyer');
});
test('a shortfall reserves nothing and offers what fits; accepting reserves exactly that, with the original cap',async()=>{
  const {db}=await market(2,100);
  const v=await order(db,b1,20);
  assert.equal(v.order.state,'CREATED');assert.equal(v.order.shortfallReason,'CAP');assert.equal(v.allocation?.offeredCount,6);
  assert.equal(v.order.allocatedQuantity,0);assert.equal(v.order.payablePaise,'0');assert.equal(await credits(db,'RESERVED'),0);
  const accepted=await acceptPartial(db,b1,v.order.id);
  assert.equal(accepted.order.state,'RESERVED');assert.equal(accepted.order.allocatedQuantity,6);assert.equal(accepted.order.principalPaise,String(PRICE*6n));
  assert.equal(accepted.allocation?.capBasisQuantity,20);assert.equal(accepted.allocation?.revision,2);
  assert.equal(await credits(db,'RESERVED'),6);
  assert.equal((await acceptPartial(db,b1,v.order.id)).replayed,true,'a repeated accept answers with the current order');
  await clean(db);
});
test('if supply shrinks before acceptance, a new smaller offer is returned and nothing is reserved',async()=>{
  const {db,seed}=await market(2,100);
  const v=await order(db,b1,20);assert.equal(v.allocation?.offeredCount,6);
  // Group A loses all but one credit (reversed by an operator).
  await db.query(`UPDATE demo_credits SET state='REVERSED' WHERE id=ANY($1::text[])`,[seed.groups[0].creditIds.slice(1)]);
  const reoffer=await acceptPartial(db,b1,v.order.id);
  assert.equal(reoffer.order.state,'CREATED');assert.equal(reoffer.allocation?.offeredCount,4);assert.equal(await credits(db,'RESERVED'),0);
  const accepted=await acceptPartial(db,b1,v.order.id);assert.equal(accepted.order.allocatedQuantity,4);
  await clean(db);
});
test('accept-partial is refused for orders that are not shortfall offers',async()=>{
  const {db}=await market(20,10);const v=await order(db,b1,2);
  await assert.rejects(acceptPartial(db,b1,v.order.id),code('ORDER_NOT_PARTIAL'));
  await cancelOrder(db,b1,v.order.id);await assert.rejects(acceptPartial(db,b1,v.order.id),code('ORDER_NOT_PARTIAL'));
});
test('cancel releases credits, is idempotent, and is invisible to other buyers',async()=>{
  const {db}=await market(20,10);const v=await order(db,b1,2);
  await assert.rejects(cancelOrder(db,b2,v.order.id),code('NOT_FOUND'));await assert.rejects(getOrder(db,b2,v.order.id),code('NOT_FOUND'));
  await assert.rejects(getOrder(db,b1,'not-a-uuid'),code('NOT_FOUND'));
  const c=await cancelOrder(db,b1,v.order.id);assert.equal(c.order.state,'CANCELLED');assert.ok(c.items.every(i=>!i.active));
  assert.equal(await credits(db,'RESERVED'),0);assert.equal((await cancelOrder(db,b1,v.order.id)).replayed,true);
  // The released credits are offered again, with their original availability time.
  const since=(await db.query('SELECT available_since FROM demo_credits WHERE id=$1',[v.items[0].creditId])).rows[0].available_since;
  const again=await order(db,b1,2);assert.deepEqual(again.items.map(i=>i.creditId).sort(),v.items.map(i=>i.creditId).sort());
  assert.equal(String((await db.query('SELECT available_since FROM demo_credits WHERE id=$1',[v.items[0].creditId])).rows[0].available_since),String(since));
  await clean(db);
});
test('the reaper expires lapsed reservations and stale shortfall offers, then the credits are reusable',async()=>{
  const {db}=await market(2,100);
  const reserved=await order(db,b1,2),shortfall=await order(db,b2,20);
  assert.equal(shortfall.order.state,'CREATED');
  await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[reserved.order.id]);
  assert.equal((await assertMarketInvariants(db,{lapseGraceSeconds:0})).map(v=>v.code).join(),'RESERVATION_LAPSED','the oracle notices an unreaped lapse');
  await db.query(`UPDATE demo_orders SET created_at=now()-interval '16 minutes' WHERE id=$1`,[shortfall.order.id]);
  const result=await withScenarioLock(db,'market',(tx,asOf)=>reapExpired(tx,'market',asOf));
  assert.deepEqual(result,{expired:1,released:2,shortfallsCancelled:1});
  assert.equal((await getOrder(db,b1,reserved.order.id)).order.state,'EXPIRED');assert.equal((await getOrder(db,b2,shortfall.order.id)).order.state,'CANCELLED');
  assert.equal(await credits(db,'RESERVED'),0);await clean(db);
  await assert.rejects(acceptPartial(db,b2,shortfall.order.id),code('ORDER_NOT_PARTIAL'));
});
test('order creation reaps first, so a lapsed reservation never blocks new buyers',async()=>{
  const {db}=await market(1,10);
  const v=await order(db,b1,1);await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[v.order.id]);
  const w=await order(db,b2,1);assert.equal(w.order.state,'RESERVED');assert.equal((await getOrder(db,b1,v.order.id)).order.state,'EXPIRED');
  await clean(db);
});
test('buyer limits: three open orders, and at most 10% of eligible supply reserved',async()=>{
  const {db}=await market(20,10);
  await assert.rejects(order(db,b1,21),code('BUYER_LIMIT'),'21 > 10% of 200');
  const open=[await order(db,b1,1),await order(db,b1,1),await order(db,b1,1)];
  await assert.rejects(order(db,b1,1),code('BUYER_LIMIT'),'a fourth open order');
  await cancelOrder(db,b1,open[0].order.id);await order(db,b1,1);
  // Each buyer has their own share; eligible supply counts available and reserved credits (200), so the share is 20.
  assert.equal((await order(db,b2,20)).order.state,'RESERVED');
  await assert.rejects(order(db,b2,1),code('BUYER_LIMIT'),'20 reserved + 1 > 20');
});
test('price: the latest effective entry is used, future entries are ignored, and no price aborts the order',async()=>{
  const {db}=await market(5,10,{price:null});
  await assert.rejects(order(db,b1,1),code('PRICE_NOT_CONFIGURED'));
  assert.equal(await credits(db,'RESERVED'),0);assert.equal((await db.query('SELECT count(*)::int AS n FROM demo_orders')).rows[0].n,0,'rolled back');
  await db.query(`INSERT INTO demo_price_list(scenario_id,effective_from,unit_price_paise,created_by) VALUES ('market',now()-interval '2 days',1000,'t'),('market',now()-interval '1 day',2000,'t'),('market',now()+interval '1 day',9999,'t')`);
  const v=await order(db,b1,2,{quotedTotalPaise:'4000'});assert.equal(v.order.unitPricePaise,'2000');assert.equal(v.priceChangedFromQuote,false);
  assert.equal((await order(db,b2,1,{quotedTotalPaise:'1000'})).priceChangedFromQuote,true);
});
test('only buyers may order, input is validated, and non-demo scenarios are refused',async()=>{
  const {db}=await market(5,10);
  for(const role of ['agent','verifier'])await assert.rejects(createOrder(db,{id:'x',scenarioId:'market',role},{requestId:randomUUID(),quantity:1}),code('FORBIDDEN'));
  await assert.rejects(createOrder(db,b1,{requestId:'nope',quantity:1}),code('INVALID_REQUEST_ID'));
  for(const quantity of [0,101,1.5])await assert.rejects(createOrder(db,b1,{requestId:randomUUID(),quantity}),code('INVALID_QUANTITY'));
  await assert.rejects(createOrder(db,b1,{requestId:randomUUID(),quantity:1,quotedTotalPaise:'-5'}),code('INVALID_QUOTE'));
  await db.query(`INSERT INTO scenarios(id) VALUES ('plain')`);
  await assert.rejects(createOrder(db,buyer('buyer-1','plain'),{requestId:randomUUID(),quantity:1}),code('DEMO_SCOPE_ONLY'));
});
test('every market action is audited against a case and the audit chain still verifies',async()=>{
  const {db}=await market(3,10);
  const v=await order(db,b1,1);await cancelOrder(db,b1,v.order.id);
  const w=await order(db,b2,1);await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[w.order.id]);
  await withScenarioLock(db,'market',(tx,asOf)=>reapExpired(tx,'market',asOf));
  const events=(await db.query(`SELECT event_type,actor_id FROM audit_events WHERE event_type LIKE 'market.%' ORDER BY created_at,event_type`)).rows;
  assert.deepEqual(events.map(e=>e.event_type).sort(),['market.order.cancelled','market.order.expired','market.order.reserved','market.order.reserved']);
  assert.equal(events.find(e=>e.event_type==='market.order.expired')?.actor_id,'system:market');
  while((await chainAudit(db)).processed>0){}
  await verifyAuditFull(db);
});
