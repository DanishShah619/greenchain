import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,race,testDatabaseUrl} from '../support/pg.js';
import {seedMarket,buyer,PRICE} from '../support/market.js';
import {createOrder,reapExpired} from '../../src/modules/market/application/orders.js';
import {withScenarioLock} from '../../src/modules/market/application/lock.js';
import {DEFAULT_PAYMENTS,handlePaymentEvent,startPaymentAttempt,type PaymentConfig,type WebhookResult} from '../../src/modules/market/application/payments.js';
import {eventBody,signedDelivery} from '../../src/modules/market/infrastructure/simulator.js';
import {assertMarketInvariants} from '../../src/modules/market/application/invariants.js';
import type {Database} from '../../src/kernel/database.js';
const opts={skip:testDatabaseUrl?false:'TEST_DATABASE_URL is not set (the guard test fails loudly in npm run test:pg)'};
const config:PaymentConfig={...DEFAULT_PAYMENTS,secrets:['race-webhook-secret']};
const success=(ref:string,id=`evt_${randomUUID()}`,amount=PRICE*2n)=>signedDelivery(config,eventBody({id,type:'payment.succeeded',providerRef:ref,amountPaise:amount,currency:'INR'}));
const values=(results:PromiseSettledResult<WebhookResult>[])=>results.map(r=>{assert.equal(r.status,'fulfilled',String((r as PromiseRejectedResult).reason));return (r as PromiseFulfilledResult<WebhookResult>).value;});
const n=async(db:Database,sql:string)=>(await db.query(sql)).rows[0].n as number;
async function paying(db:Database,who='buyer-1',quantity=2){
  const v=await createOrder(db,buyer(who),{requestId:randomUUID(),quantity});
  const p=await startPaymentAttempt(db,buyer(who),v.order.id,{acceptSnapshotHash:v.snapshotHash});
  return {orderId:v.order.id,attemptId:p.attemptId,ref:p.providerRef};
}
test('the same webhook delivered 8 times at once is applied exactly once',opts,async()=>{
  const t=await createTestDatabase();
  try{
    await seedMarket(t.db,{groups:20,perGroup:10});const o=await paying(t.db);
    const pools=Array.from({length:4},()=>t.connect()),delivery=success(o.ref,'evt_dup');
    const out=values(await race(8,i=>handlePaymentEvent(pools[i%4],delivery,config)));
    assert.ok(out.every(r=>r.status===200&&r.outcome==='FULFILLED'),JSON.stringify(out));
    assert.equal(out.filter(r=>!r.replayed).length,1,'one delivery applied it, the rest are replays');
    assert.equal(await n(t.db,'SELECT count(*)::int AS n FROM demo_ledger_entries'),2);
    assert.equal(await n(t.db,'SELECT count(*)::int AS n FROM demo_payment_events'),1);
    assert.deepEqual(await assertMarketInvariants(t.db),[]);
  }finally{await t.close();}
});
test('distinct success events for one attempt at once: one fulfilment, no refund',opts,async()=>{
  const t=await createTestDatabase();
  try{
    await seedMarket(t.db,{groups:20,perGroup:10});const o=await paying(t.db);
    const pools=Array.from({length:4},()=>t.connect());
    const out=values(await race(6,i=>handlePaymentEvent(pools[i%4],success(o.ref),config)));
    assert.equal(out.filter(r=>r.outcome==='FULFILLED').length,1);
    assert.ok(out.every(r=>r.outcome==='FULFILLED'||r.outcome==='IGNORED_SAME_ATTEMPT'),JSON.stringify(out));
    assert.equal(await n(t.db,'SELECT count(*)::int AS n FROM demo_payment_refunds'),0);
    assert.deepEqual(await assertMarketInvariants(t.db),[]);
  }finally{await t.close();}
});
test('two attempts capturing money at the same moment: one fulfils, the other is refunded',opts,async()=>{
  const t=await createTestDatabase();
  try{
    await seedMarket(t.db,{groups:20,perGroup:10});
    for(let round=0;round<5;round++){
      const o=await paying(t.db,`buyer-${round%2+1}`);
      const second=randomUUID(),ref2=`sim_second_${round}`;
      await t.db.query(`INSERT INTO demo_payment_attempts(id,order_id,scenario_id,provider,provider_ref,state,amount_paise) VALUES ($1,$2,'market','simulator',$3,'CREATED',$4)`,[second,o.orderId,ref2,String(PRICE*2n)]);
      const [a,b]=[t.connect(),t.connect()];
      const out=values(await race(2,i=>handlePaymentEvent(i?b:a,success(i?ref2:o.ref),config)));
      assert.deepEqual(out.map(r=>r.outcome).sort(),['FULFILLED','REFUND_DUPLICATE_ATTEMPT'],`round ${round}: ${JSON.stringify(out)}`);
    }
    assert.equal(await n(t.db,`SELECT count(*)::int AS n FROM demo_payment_refunds WHERE kind='DUPLICATE_ATTEMPT'`),5);
    assert.deepEqual(await assertMarketInvariants(t.db),[]);
  }finally{await t.close();}
});
test('reservation expiry racing payment success and a competing buyer: always fulfilled or fully refunded, never both',opts,async t0=>{
  const t=await createTestDatabase();
  try{
    const buyers=Array.from({length:10},(_,i)=>`late-${i}`);
    await seedMarket(t.db,{groups:1,perGroup:40,buyers});
    const pools=Array.from({length:6},()=>t.connect());
    const outcomes:string[]=[];
    for(let round=0;round<8;round++){
      const o=await paying(t.db,buyers[round%5],1);
      await t.db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[o.orderId]);
      // Even rounds: the payment reaches the lock first (the lapsed but unreaped order is still honoured).
      // Odd rounds: the reaper and a competing buyer go first, so the released credit is taken and the payment is refunded.
      const paymentFirst=round%2===0,later=(ms:number)=>new Promise(r=>setTimeout(r,ms));
      const work:(()=>Promise<unknown>)[]=[
        async()=>{if(!paymentFirst)await later(50);return handlePaymentEvent(pools[0],success(o.ref,undefined,PRICE),config);},
        async()=>{if(paymentFirst)await later(50);return withScenarioLock(pools[1],'market',(tx,asOf)=>reapExpired(tx,'market',asOf));},
        // Another buyer wants one credit too; FCAE gives the lowest free credit id, which is the one just released.
        async()=>{if(paymentFirst)await later(50);return createOrder(pools[2],buyer(buyers[5+round%5]),{requestId:randomUUID(),quantity:1});},
      ];
      const results=await race(work.length,i=>work[i]());
      for(const r of results)if(r.status==='rejected'&&(r.reason as any)?.code!=='BUYER_LIMIT')assert.fail(`round ${round}: ${(r.reason as any)?.code??r.reason}`);
      outcomes.push(((results[0] as PromiseFulfilledResult<WebhookResult>).value.outcome)!);
    }
    t0.diagnostic(`outcomes: ${outcomes.join(', ')}`);
    assert.ok(outcomes.every(o=>['FULFILLED','REVALIDATED_FULFILLED','REFUND_LATE_UNFILLABLE'].includes(o)),outcomes.join());
    assert.ok(outcomes.includes('FULFILLED')&&outcomes.includes('REFUND_LATE_UNFILLABLE'),`both orderings exercised: ${outcomes.join()}`);
    const paid=await n(t.db,`SELECT count(*)::int AS n FROM demo_orders WHERE state='FULFILLED'`),refunded=await n(t.db,`SELECT count(*)::int AS n FROM demo_orders WHERE state='REFUND_PENDING'`);
    assert.equal(paid+refunded,8,'each paid order ends fulfilled or refunded');
    assert.equal(await n(t.db,`SELECT count(*)::int AS n FROM demo_credits WHERE state='SOLD'`),paid);
    assert.deepEqual(await assertMarketInvariants(t.db,{lapseGraceSeconds:3600}),[]);
  }finally{await t.close();}
});
test('an apply that fails is not recorded, and concurrent redeliveries afterwards apply it once',opts,async()=>{
  const t=await createTestDatabase();
  try{
    await seedMarket(t.db,{groups:20,perGroup:10});const o=await paying(t.db);
    await t.db.query(`CREATE FUNCTION test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected fault'; END; $$`);
    await t.db.query('CREATE TRIGGER test_fault BEFORE INSERT ON demo_ledger_entries FOR EACH ROW EXECUTE FUNCTION test_fault()');
    const delivery=success(o.ref,'evt_after_fault');
    assert.equal((await handlePaymentEvent(t.db,delivery,config)).status,503);
    assert.equal(await n(t.db,'SELECT count(*)::int AS n FROM demo_payment_events'),0);
    await t.db.query('DROP TRIGGER test_fault ON demo_ledger_entries');
    const pools=Array.from({length:3},()=>t.connect());
    const out=values(await race(6,i=>handlePaymentEvent(pools[i%3],delivery,config)));
    assert.ok(out.every(r=>r.outcome==='FULFILLED'));assert.equal(out.filter(r=>!r.replayed).length,1);
    assert.deepEqual(await assertMarketInvariants(t.db),[]);
  }finally{await t.close();}
});
test('a failing event delivered concurrently is counted exactly, parked once, and never applied',opts,async()=>{
  const t=await createTestDatabase();
  try{
    await seedMarket(t.db,{groups:20,perGroup:10});const o=await paying(t.db);
    await t.db.query(`CREATE FUNCTION test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected fault'; END; $$`);
    await t.db.query('CREATE TRIGGER test_fault BEFORE INSERT ON demo_ledger_entries FOR EACH ROW EXECUTE FUNCTION test_fault()');
    const strict={...config,maxEventFailures:3},delivery=success(o.ref,'evt_dead');
    const pools=Array.from({length:4},()=>t.connect());
    const out=values(await race(8,i=>handlePaymentEvent(pools[i%4],delivery,strict)));
    const failed=out.filter(r=>r.status===503).length,parkedNow=out.filter(r=>r.justParked).length;
    assert.equal(parkedNow,1,`exactly one delivery parks it: ${JSON.stringify(out.map(r=>r.code))}`);
    assert.ok(out.every(r=>r.status===503||(r.status===200&&r.parked)),'every delivery either failed or was told the event is parked');
    const row=(await t.db.query(`SELECT failures,parked FROM demo_payment_event_failures WHERE provider_event_id='evt_dead'`)).rows[0];
    // Deliveries that raced past the parked check before the bound was reached still attempted the apply; each carries its cause.
    const attempted=out.filter(r=>r.error).length;
    assert.ok(failed>=1&&attempted>=failed+parkedNow);
    assert.equal(row.parked,true);assert.equal(row.failures,attempted,'every attempted apply is counted exactly once');
    assert.equal(await n(t.db,'SELECT count(*)::int AS n FROM demo_payment_events'),0);
    assert.deepEqual(await assertMarketInvariants(t.db),[]);
  }finally{await t.close();}
});
