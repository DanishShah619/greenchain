import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migratedPglite} from './support/pglite.js';
import {seedMarket,buyer,PRICE} from './support/market.js';
import {cancelOrder,createOrder,getOrder} from '../src/modules/market/application/orders.js';
import {DEFAULT_PAYMENTS,handlePaymentEvent,settleRefunds,signWebhook,startPaymentAttempt,type PaymentConfig} from '../src/modules/market/application/payments.js';
import {eventBody,signedDelivery,simulate} from '../src/modules/market/infrastructure/simulator.js';
import {assertMarketInvariants} from '../src/modules/market/application/invariants.js';
import {chainAudit,verifyAuditFull} from '../src/modules/audit/application/audit.js';
import type {Database} from '../src/kernel/database.js';
const config:PaymentConfig={...DEFAULT_PAYMENTS,secrets:['test-webhook-secret-current','test-webhook-secret-previous']};
const b1=buyer('buyer-1'),b2=buyer('buyer-2'),presenter={id:'presenter',scenarioId:'market',role:'agent'};
const code=(c:string)=>(e:any)=>{assert.equal(e?.code,c);return true;};
const clean=async(db:Database)=>assert.deepEqual(await assertMarketInvariants(db,{lapseGraceSeconds:3600}),[]);
const count=async(db:Database,sql:string,values:unknown[]=[])=>(await db.query(sql,values)).rows[0].n as number;
async function setup(groups=20,perGroup=10,quantity=2){
  const {db}=await migratedPglite();await seedMarket(db,{groups,perGroup});
  const v=await createOrder(db,b1,{requestId:randomUUID(),quantity});
  const paying=await startPaymentAttempt(db,b1,v.order.id,{acceptSnapshotHash:v.snapshotHash});
  return {db,order:v,attemptId:paying.attemptId,providerRef:paying.providerRef};
}
/** Deliver one provider event through the real handler. */
function deliver(db:Database,providerRef:string,type:string,o:{amount?:bigint;id?:string;currency?:string;now?:number}={}){
  const body=eventBody({id:o.id??`evt_${randomUUID()}`,type:type as any,providerRef,amountPaise:o.amount??PRICE*2n,currency:o.currency??'INR'});
  return handlePaymentEvent(db,signedDelivery(config,body,o.now),config,o.now);
}
test('pending extends the reservation (capped), success fulfils: credits sold, ledger balanced, groups updated',async()=>{
  const {db,order,providerRef}=await setup();
  assert.equal((await getOrder(db,b1,order.order.id)).order.state,'AWAITING_PAYMENT');
  assert.deepEqual(await deliver(db,providerRef,'payment.pending'),{status:200,outcome:'ATTEMPT_UPDATED'});
  const held=await getOrder(db,b1,order.order.id);
  const extended=Date.parse(held.order.reservedUntil!)-Date.parse(held.order.allocatedAt!);
  assert.ok(extended>=900_000-5000&&extended<=1_800_000,`extended to ~15 min, never past 30 (got ${extended})`);
  assert.deepEqual(await deliver(db,providerRef,'payment.succeeded'),{status:200,outcome:'FULFILLED'});
  const done=await getOrder(db,b1,order.order.id);
  assert.equal(done.order.state,'FULFILLED');assert.equal(done.payments[0].state,'SUCCEEDED');
  assert.deepEqual(done.purchased.map(p=>p.pricePaise),[String(PRICE),String(PRICE)]);
  const ledger=(await db.query('SELECT gross_paise,commission_paise,net_paise FROM demo_ledger_entries ORDER BY credit_id')).rows;
  assert.deepEqual(ledger.map(l=>[String(l.gross_paise),String(l.commission_paise),String(l.net_paise)]),[[String(PRICE),'5002','95028'],[String(PRICE),'5002','95028']]);
  assert.equal(await count(db,`SELECT count(*)::int AS n FROM demo_credits WHERE state='SOLD'`),2);
  assert.equal(await count(db,'SELECT count(*)::int AS n FROM demo_group_state'),2);
  await clean(db);
  while((await chainAudit(db)).processed>0){}
  await verifyAuditFull(db);
});
test('the same event replayed returns the stored outcome; the same id with a different body is refused',async()=>{
  const {db,providerRef}=await setup();const id='evt_fixed_1';
  assert.equal((await deliver(db,providerRef,'payment.succeeded',{id})).outcome,'FULFILLED');
  assert.deepEqual(await deliver(db,providerRef,'payment.succeeded',{id}),{status:200,outcome:'FULFILLED',replayed:true});
  assert.deepEqual(await deliver(db,providerRef,'payment.failed',{id}),{status:409,code:'EVENT_REUSE'});
  assert.equal(await count(db,'SELECT count(*)::int AS n FROM demo_ledger_entries'),2);await clean(db);
});
test('a second success event for the same attempt is the same charge: ignored, never refunded',async()=>{
  const {db,providerRef}=await setup();
  await deliver(db,providerRef,'payment.succeeded');
  assert.equal((await deliver(db,providerRef,'payment.succeeded')).outcome,'IGNORED_SAME_ATTEMPT');
  assert.equal(await count(db,'SELECT count(*)::int AS n FROM demo_payment_refunds'),0);await clean(db);
});
test('a correct-amount success after a wrong-amount one on the same attempt is a real payment: it fulfils, then repeats are ignored',async()=>{
  const {db,order,providerRef}=await setup();
  assert.equal((await deliver(db,providerRef,'payment.succeeded',{amount:PRICE})).outcome,'AMOUNT_MISMATCH');
  assert.equal((await deliver(db,providerRef,'payment.succeeded')).outcome,'FULFILLED','the correct payment is not mistaken for the refunded one');
  const v=await getOrder(db,b1,order.order.id);
  assert.equal(v.order.state,'FULFILLED');assert.deepEqual(v.refunds,[{kind:'AMOUNT_MISMATCH',state:'PENDING',amountPaise:String(PRICE)}]);
  assert.equal((await deliver(db,providerRef,'payment.succeeded')).outcome,'IGNORED_SAME_ATTEMPT','the correct charge reported again');
  await clean(db);
});
test('a second attempt that also captures money is refunded and the order is untouched',async()=>{
  const {db,order,providerRef}=await setup();
  await deliver(db,providerRef,'payment.succeeded');
  assert.equal((await simulate(db,presenter,order.order.id,'double_charge',config) as any).outcome,'REFUND_DUPLICATE_ATTEMPT');
  let v=await getOrder(db,b1,order.order.id);assert.equal(v.order.state,'FULFILLED');assert.deepEqual(v.refunds,[{kind:'DUPLICATE_ATTEMPT',state:'PENDING',amountPaise:String(PRICE*2n)}]);
  await settleRefunds(db,'market');
  v=await getOrder(db,b1,order.order.id);assert.equal(v.order.state,'FULFILLED');assert.equal(v.refunds[0].state,'REFUNDED');
  await clean(db);
});
test('an amount or currency mismatch refunds the captured amount on every branch and never changes the order',async()=>{
  // Fresh order.
  {const {db,order,providerRef}=await setup();
   assert.equal((await deliver(db,providerRef,'payment.succeeded',{amount:PRICE})).outcome,'AMOUNT_MISMATCH');
   const v=await getOrder(db,b1,order.order.id);assert.equal(v.order.state,'AWAITING_PAYMENT');assert.equal(v.payments[0].mismatch,true);
   assert.deepEqual(v.refunds,[{kind:'AMOUNT_MISMATCH',state:'PENDING',amountPaise:String(PRICE)}]);
   assert.equal(await count(db,`SELECT count(*)::int AS n FROM demo_credits WHERE state='SOLD'`),0);await clean(db);}
  // Wrong currency.
  {const {db,providerRef}=await setup();assert.equal((await deliver(db,providerRef,'payment.succeeded',{currency:'USD'})).outcome,'AMOUNT_MISMATCH');}
  // Already fulfilled: a second, wrong-amount event on another attempt is refunded as a mismatch.
  {const {db,order,providerRef}=await setup();await deliver(db,providerRef,'payment.succeeded');
   await db.query(`INSERT INTO demo_payment_attempts(id,order_id,scenario_id,provider,provider_ref,state,amount_paise) VALUES ($1,$2,'market','simulator','sim_extra','CREATED',$3)`,[randomUUID(),order.order.id,String(PRICE*2n)]);
   assert.equal((await deliver(db,'sim_extra','payment.succeeded',{amount:PRICE*3n})).outcome,'AMOUNT_MISMATCH');
   assert.equal((await getOrder(db,b1,order.order.id)).order.state,'FULFILLED');await clean(db);}
  // Lapsed and reaped.
  {const {db,order,providerRef}=await setup();
   await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[order.order.id]);
   await createOrder(db,b2,{requestId:randomUUID(),quantity:1});
   assert.equal((await deliver(db,providerRef,'payment.succeeded',{amount:1n})).outcome,'AMOUNT_MISMATCH');
   assert.equal((await getOrder(db,b1,order.order.id)).order.state,'EXPIRED');await clean(db);}
});
test('late success with the credits still free fulfils through a new generation of holds',async()=>{
  const {db,order}=await setup();
  const r=await simulate(db,presenter,order.order.id,'late_success',config) as any;
  assert.equal(r.outcome,'REVALIDATED_FULFILLED');
  const v=await getOrder(db,b1,order.order.id);assert.equal(v.order.state,'FULFILLED');
  assert.deepEqual(v.items.map(i=>i.creditId).sort(),order.items.map(i=>i.creditId).sort(),'the same credits');
  const gens=(await db.query('SELECT generation,active FROM demo_order_items WHERE order_id=$1 ORDER BY generation,credit_id',[order.order.id])).rows;
  assert.deepEqual(gens.map(g=>`${g.generation}:${g.active}`),['1:false','1:false','2:true','2:true']);
  await clean(db);
});
test('late success after the credits were taken is refunded in full and sells nothing',async()=>{
  const {db,order,providerRef}=await setup(1,10,1);
  await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[order.order.id]);
  const other=await createOrder(db,b2,{requestId:randomUUID(),quantity:1});
  assert.equal(other.items[0].creditId,order.items[0].creditId,'the next buyer took the same credit');
  assert.equal((await deliver(db,providerRef,'payment.succeeded',{amount:PRICE})).outcome,'REFUND_LATE_UNFILLABLE');
  let v=await getOrder(db,b1,order.order.id);assert.equal(v.order.state,'REFUND_PENDING');assert.equal(v.refunds[0].kind,'LATE_UNFILLABLE');
  assert.equal(await count(db,`SELECT count(*)::int AS n FROM demo_credits WHERE state='SOLD'`),0);
  await clean(db);
  assert.deepEqual(await settleRefunds(db,'market'),{settled:1,closed:1});
  v=await getOrder(db,b1,order.order.id);assert.equal(v.order.state,'REFUNDED');assert.equal(v.refunds[0].state,'REFUNDED');
  assert.equal((await getOrder(db,b2,other.order.id)).order.state,'RESERVED','the other buyer is unaffected');
  await clean(db);
});
test('success after the buyer cancelled fulfils when the credits are still free (decision B10)',async()=>{
  const {db,order,providerRef}=await setup();
  await cancelOrder(db,b1,order.order.id);
  assert.equal((await deliver(db,providerRef,'payment.succeeded')).outcome,'REVALIDATED_FULFILLED');
  assert.equal((await getOrder(db,b1,order.order.id)).order.state,'FULFILLED');await clean(db);
});
test('failure keeps the order payable, a new attempt can follow, and a late failure never undoes a success',async()=>{
  const {db,order,providerRef}=await setup();
  assert.equal((await deliver(db,providerRef,'payment.failed')).outcome,'ATTEMPT_UPDATED');
  assert.equal((await getOrder(db,b1,order.order.id)).order.state,'AWAITING_PAYMENT');
  const retry=await startPaymentAttempt(db,b1,order.order.id,{acceptSnapshotHash:order.snapshotHash});
  assert.notEqual(retry.attemptId,(await getOrder(db,b1,order.order.id)).payments[0].id);
  assert.equal((await deliver(db,retry.providerRef,'payment.succeeded')).outcome,'FULFILLED');
  assert.equal((await deliver(db,retry.providerRef,'payment.failed')).outcome,'IGNORED_TERMINAL');
  assert.equal((await getOrder(db,b1,order.order.id)).payments[1].state,'SUCCEEDED');
  // The first attempt failed; its money may still arrive. That is a second charge on a settled order.
  assert.equal((await deliver(db,providerRef,'payment.succeeded')).outcome,'REFUND_DUPLICATE_ATTEMPT');
  await clean(db);
});
test('starting payment: exact snapshot required, one open attempt, only for a payable order you own',async()=>{
  const {db,order,attemptId}=await setup();
  await assert.rejects(startPaymentAttempt(db,b1,order.order.id,{acceptSnapshotHash:'0'.repeat(64)}),code('SNAPSHOT_MISMATCH'));
  assert.equal((await startPaymentAttempt(db,b1,order.order.id,{acceptSnapshotHash:order.snapshotHash})).attemptId,attemptId,'the open attempt is resumed');
  await assert.rejects(startPaymentAttempt(db,b2,order.order.id,{acceptSnapshotHash:order.snapshotHash}),code('NOT_FOUND'));
  await assert.rejects(startPaymentAttempt(db,presenter,order.order.id,{acceptSnapshotHash:order.snapshotHash}),code('FORBIDDEN'));
  await cancelOrder(db,b1,order.order.id);
  await assert.rejects(startPaymentAttempt(db,b1,order.order.id,{acceptSnapshotHash:order.snapshotHash}),code('ORDER_NOT_PAYABLE'));
  // A shortfall offer (nothing reserved) cannot be paid.
  {const small=(await migratedPglite()).db;await seedMarket(small,{groups:2,perGroup:100});
   const shortfall=await createOrder(small,b1,{requestId:randomUUID(),quantity:20});assert.equal(shortfall.order.state,'CREATED');
   await assert.rejects(startPaymentAttempt(small,b1,shortfall.order.id,{acceptSnapshotHash:shortfall.snapshotHash}),code('ORDER_NOT_PAYABLE'));}
  // Lapsed: reaped before the attempt is created.
  const lapsed=await createOrder(db,b2,{requestId:randomUUID(),quantity:1});
  await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[lapsed.order.id]);
  await assert.rejects(startPaymentAttempt(db,b2,lapsed.order.id,{acceptSnapshotHash:lapsed.snapshotHash}),code('ORDER_NOT_PAYABLE'));
});
test('webhook authentication: signature over timestamp and raw body, a tolerance window, rotation, size cap; failures write nothing',async()=>{
  const {db,providerRef}=await setup();
  const body=eventBody({id:'evt_auth',type:'payment.succeeded',providerRef,amountPaise:PRICE*2n,currency:'INR'});
  const now=Date.now(),ts=String(Math.floor(now/1000));
  const send=(raw:{body:Buffer;signature?:string;timestamp?:string})=>handlePaymentEvent(db,raw,config,now);
  const cases:[string,{body:Buffer;signature?:string;timestamp?:string},number][]=[
    ['missing signature',{body,timestamp:ts},401],
    ['missing timestamp',{body,signature:signWebhook(config.secrets[0],ts,body)},401],
    ['wrong secret',{body,timestamp:ts,signature:signWebhook('not-the-secret',ts,body)},401],
    ['tampered body',{body:Buffer.from(body.toString().replace('"INR"','"INX"')),timestamp:ts,signature:signWebhook(config.secrets[0],ts,body)},401],
    ['timestamp not covered',{body,timestamp:String(Number(ts)-1),signature:signWebhook(config.secrets[0],ts,body)},401],
    ['stale (6 min)',{body,timestamp:String(Number(ts)-360),signature:signWebhook(config.secrets[0],String(Number(ts)-360),body)},401],
    ['future (6 min)',{body,timestamp:String(Number(ts)+360),signature:signWebhook(config.secrets[0],String(Number(ts)+360),body)},401],
    ['too large',{body:Buffer.alloc(config.maxBodyBytes+1,32),timestamp:ts,signature:'0'.repeat(64)},413],
  ];
  for(const [name,raw,status] of cases)assert.equal((await send(raw)).status,status,name);
  const notJson=Buffer.from('not json');
  assert.equal((await send({body:notJson,timestamp:ts,signature:signWebhook(config.secrets[0],ts,notJson)})).status,400);
  assert.equal(await count(db,'SELECT count(*)::int AS n FROM demo_payment_events'),0,'nothing recorded for rejected deliveries');
  const unknown=eventBody({id:'evt_unknown',type:'payment.succeeded',providerRef:'sim_nobody',amountPaise:1n,currency:'INR'});
  assert.deepEqual(await send({body:unknown,timestamp:ts,signature:signWebhook(config.secrets[0],ts,unknown)}),{status:404,code:'PAYMENT_UNMATCHED',eventId:'evt_unknown'});
  // The previous secret still verifies during rotation.
  assert.equal((await send({body,timestamp:ts,signature:signWebhook(config.secrets[1],ts,body)})).outcome,'FULFILLED');
});
test('if applying fails, nothing is recorded and the redelivered event is applied from scratch',async()=>{
  const {db,order,providerRef}=await setup();
  // A temporary fault inside the apply transaction (the ledger insert fails).
  await db.query(`CREATE FUNCTION test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected fault'; END; $$`);
  await db.query('CREATE TRIGGER test_fault BEFORE INSERT ON demo_ledger_entries FOR EACH ROW EXECUTE FUNCTION test_fault()');
  const id='evt_retry';
  assert.deepEqual(await deliver(db,providerRef,'payment.succeeded',{id}),{status:503,code:'PAYMENT_APPLY_FAILED',eventId:id});
  assert.equal(await count(db,'SELECT count(*)::int AS n FROM demo_payment_events'),0,'the event is not recorded');
  assert.equal((await getOrder(db,b1,order.order.id)).order.state,'AWAITING_PAYMENT');
  await db.query('DROP TRIGGER test_fault ON demo_ledger_entries');
  assert.deepEqual(await deliver(db,providerRef,'payment.succeeded',{id}),{status:200,outcome:'FULFILLED'});
  await clean(db);
});
test('simulator: presenter only; replay resends the exact last event; refund settles',async()=>{
  const {db,order}=await setup();
  await assert.rejects(simulate(db,b1,order.order.id,'success',config),code('FORBIDDEN'));
  await assert.rejects(simulate(db,presenter,randomUUID(),'success',config),code('NOT_FOUND'));
  assert.equal((await simulate(db,presenter,order.order.id,'success',config) as any).outcome,'FULFILLED');
  assert.deepEqual(await simulate(db,presenter,order.order.id,'replay',config),{status:200,outcome:'FULFILLED',replayed:true});
  assert.deepEqual(await simulate(db,presenter,order.order.id,'refund',config),{status:200,settled:0,closed:0});
  await clean(db);
});
