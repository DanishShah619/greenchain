import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migratedPglite} from './support/pglite.js';
import {seedMarket,buyer,PRICE} from './support/market.js';
import {createOrder,getOrder} from '../src/modules/market/application/orders.js';
import {DEFAULT_PAYMENTS,handlePaymentEvent,listFailedPaymentEvents,retryParkedPaymentEvent,startPaymentAttempt,type PaymentConfig} from '../src/modules/market/application/payments.js';
import {eventBody,signedDelivery} from '../src/modules/market/infrastructure/simulator.js';
import {assertMarketInvariants} from '../src/modules/market/application/invariants.js';
import {declareMarketApiMetrics,declareMarketWorkerMetrics} from '../src/modules/market/application/metrics.js';
import {DEFAULT_SWEEP,marketSweep,newSweepState} from '../src/modules/market/application/sweep.js';
import {DEFAULT_MARKET} from '../src/modules/market/application/orders.js';
import {buildApp} from '../src/bootstrap/app.js';
import {WEBHOOK_PATH} from '../src/modules/market/http/routes.js';
import {Metrics} from '../src/kernel/metrics.js';
import type {Database} from '../src/kernel/database.js';
// Audit issue 1: a payment event whose apply keeps failing must say why (in logs, never in the response), stop being
// retried after a bound, and be recoverable by an operator once the cause is fixed.
const config:PaymentConfig={...DEFAULT_PAYMENTS,secrets:['dead-letter-test-secret-32-characters'],maxEventFailures:3};
const b1=buyer('buyer-1');
const code=(c:string)=>(e:any)=>{assert.equal(e?.code,c);return true;};
async function setup(){
  const {db}=await migratedPglite();await seedMarket(db,{groups:20,perGroup:10});
  const v=await createOrder(db,b1,{requestId:randomUUID(),quantity:2});
  const p=await startPaymentAttempt(db,b1,v.order.id,{acceptSnapshotHash:v.snapshotHash});
  const body=(id:string,amount=PRICE*2n)=>eventBody({id,type:'payment.succeeded',providerRef:p.providerRef,amountPaise:amount,currency:'INR'});
  const deliver=(id:string,amount?:bigint)=>handlePaymentEvent(db,signedDelivery(config,body(id,amount)),config);
  return {db,orderId:v.order.id,deliver,body};
}
async function fault(db:Database,on:boolean){
  if(on){
    await db.query(`CREATE OR REPLACE FUNCTION test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected fault'; END; $$`);
    await db.query('CREATE TRIGGER test_fault BEFORE INSERT ON demo_ledger_entries FOR EACH ROW EXECUTE FUNCTION test_fault()');
  }else await db.query('DROP TRIGGER test_fault ON demo_ledger_entries');
}
test('a failing apply reports its cause and is counted; after the bound it is parked and no longer applied',async()=>{
  const {db,orderId,deliver}=await setup();await fault(db,true);
  const first=await deliver('evt_dl');
  assert.equal(first.status,503);assert.equal(first.code,'PAYMENT_APPLY_FAILED');
  assert.equal(first.error?.errorCode,'P0001','the SQLSTATE of the real failure is kept for the log');assert.ok(first.error?.errorName);
  assert.equal((await deliver('evt_dl')).status,503);
  let rows=await listFailedPaymentEvents(db);
  assert.equal(rows.length,1);assert.equal(rows[0].failures,2);assert.equal(rows[0].parked,false);assert.equal(rows[0].lastErrorCode,'P0001');
  // Third failure reaches the bound: the provider is told the event was received, so it stops retrying.
  const parking=await deliver('evt_dl');
  assert.equal(parking.status,200);assert.equal(parking.code,'EVENT_PARKED');assert.equal(parking.parked,true);assert.equal(parking.justParked,true);
  assert.equal(parking.error?.errorCode,'P0001','the cause of the last failure is reported when the event is parked');
  await fault(db,false);
  assert.deepEqual(await deliver('evt_dl'),{status:200,code:'EVENT_PARKED',parked:true,eventId:'evt_dl'},'a parked event is not re-applied on redelivery');
  rows=await listFailedPaymentEvents(db,{parkedOnly:true});assert.equal(rows.length,1);assert.equal(rows[0].failures,3);
  assert.equal((await getOrder(db,b1,orderId)).order.state,'AWAITING_PAYMENT','nothing was applied');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM demo_payment_events')).rows[0].n,0);
});
test('the same event id with a different body is refused while it is failing or parked',async()=>{
  const {db,deliver}=await setup();await fault(db,true);
  await deliver('evt_reuse');
  assert.deepEqual(await deliver('evt_reuse',PRICE),{status:409,code:'EVENT_REUSE'});
});
test('an operator retry applies a parked event once the cause is fixed; a provider redelivery is then a replay',async()=>{
  const {db,orderId,deliver}=await setup();await fault(db,true);
  for(let i=0;i<3;i++)await deliver('evt_retry');
  // Still broken: the retry fails, stays parked and is counted.
  const stillBroken=await retryParkedPaymentEvent(db,'simulator','evt_retry',config);
  assert.equal(stillBroken.status,503);assert.equal((await listFailedPaymentEvents(db))[0].failures,4);
  await fault(db,false);
  assert.deepEqual(await retryParkedPaymentEvent(db,'simulator','evt_retry',config),{status:200,outcome:'FULFILLED'});
  assert.equal((await getOrder(db,b1,orderId)).order.state,'FULFILLED');
  assert.deepEqual(await listFailedPaymentEvents(db),[],'the dead letter is cleared in the same transaction as the apply');
  assert.deepEqual(await deliver('evt_retry'),{status:200,outcome:'FULFILLED',replayed:true});
  await assert.rejects(retryParkedPaymentEvent(db,'simulator','evt_retry',config),code('PAYMENT_EVENT_NOT_PARKED'));
  await assert.rejects(retryParkedPaymentEvent(db,'simulator','evt_unknown',config),code('PAYMENT_EVENT_NOT_PARKED'));
  assert.deepEqual(await assertMarketInvariants(db),[]);
});
test('a delivery that succeeds after a transient failure clears the failure record',async()=>{
  const {db,deliver}=await setup();await fault(db,true);
  await deliver('evt_transient');await fault(db,false);
  assert.equal((await deliver('evt_transient')).outcome,'FULFILLED');
  assert.deepEqual(await listFailedPaymentEvents(db),[]);
});
test('over HTTP the cause stays out of the response; metrics count failures and parking; the worker exposes parked events',async()=>{
  const {db,body}=await setup();await fault(db,true);
  const metrics=new Metrics();declareMarketApiMetrics(metrics);
  const app=await buildApp(db,{origin:'http://localhost:3000',secure:false,market:{market:DEFAULT_MARKET,payments:config,demoMode:false,metrics}});
  try{
    const post=async()=>{const d=signedDelivery(config,body('evt_http'));return app.inject({method:'POST',url:WEBHOOK_PATH,headers:{'content-type':'application/json','x-greenchain-timestamp':d.timestamp,'x-greenchain-signature':d.signature},payload:d.body});};
    const failed=await post();
    assert.equal(failed.statusCode,503);assert.deepEqual(failed.json(),{code:'PAYMENT_APPLY_FAILED',retryable:true});
    await post();const parked=await post();
    assert.equal(parked.statusCode,200);assert.deepEqual(parked.json(),{received:true,parked:true});
    const text=metrics.render();
    assert.match(text,/greenchain_payment_event_failures_total\{code="PAYMENT_APPLY_FAILED"\} 3/);
    assert.match(text,/greenchain_payment_events_parked_total 1/);
    const worker=new Metrics();declareMarketWorkerMetrics(worker);
    await marketSweep(db,{config:DEFAULT_SWEEP,state:newSweepState(),metrics:worker});
    assert.match(worker.render(),/greenchain_payment_events_parked 1/);
  }finally{await app.close();}
});
