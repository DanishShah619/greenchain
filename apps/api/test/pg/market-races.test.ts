import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,race,testDatabaseUrl} from '../support/pg.js';
import {seedMarket,buyer} from '../support/market.js';
import {cancelOrder,createOrder,reapExpired} from '../../src/modules/market/application/orders.js';
import {withScenarioLock} from '../../src/modules/market/application/lock.js';
import {assertMarketInvariants} from '../../src/modules/market/application/invariants.js';
import {DEFAULT_PAYMENTS,handlePaymentEvent,startPaymentAttempt,type PaymentConfig} from '../../src/modules/market/application/payments.js';
import {eventBody,signedDelivery,simulate} from '../../src/modules/market/infrastructure/simulator.js';
const opts={skip:testDatabaseUrl?false:'TEST_DATABASE_URL is not set (the guard test fails loudly in npm run test:pg)'};
const errorCode=(r:PromiseSettledResult<unknown>)=>r.status==='rejected'?String((r.reason as any)?.code??(r.reason as Error)?.message):null;
const config:PaymentConfig={...DEFAULT_PAYMENTS,secrets:['race-webhook-secret']};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('many buyers racing for the last credits: no double hold, quotas respected, every loser gets a clean shortfall',opts,async()=>{
  const t=await createTestDatabase();
  try{
    const buyers=Array.from({length:12},(_,i)=>`racer-${i}`);
    await seedMarket(t.db,{groups:10,perGroup:2,buyers});
    const pools=Array.from({length:6},()=>t.connect());
    const results=await race(buyers.length,i=>createOrder(pools[i%pools.length],buyer(buyers[i]),{requestId:randomUUID(),quantity:2}));
    assert.deepEqual(results.map(errorCode).filter(Boolean),[],'no request fails');
    const views=results.map(r=>(r as PromiseFulfilledResult<Awaited<ReturnType<typeof createOrder>>>).value);
    // 10 groups x 2 credits; the reservation quota lets each group have one credit reserved at a time, so exactly 5 orders of 2 fit.
    assert.equal(views.filter(v=>v.order.state==='RESERVED').length,5);
    assert.ok(views.filter(v=>v.order.state==='CREATED').every(v=>v.order.shortfallReason==='QUOTA'));
    const perGroup=(await t.db.query(`SELECT b.capture_id,count(*)::int AS n FROM demo_credits c JOIN demo_issuance_batches b ON b.id=c.batch_id WHERE c.state='RESERVED' GROUP BY 1`)).rows;
    assert.equal(perGroup.length,10);assert.ok(perGroup.every(r=>r.n===1),'quota of one reserved credit per group');
    assert.deepEqual(await assertMarketInvariants(t.db),[]);
  }finally{await t.close();}
});
test('one request id sent concurrently creates one order; conflicting bodies get KEY_REUSE',opts,async()=>{
  const t=await createTestDatabase();
  try{
    await seedMarket(t.db,{groups:20,perGroup:10});
    const pools=Array.from({length:4},()=>t.connect()),requestId=randomUUID();
    const same=await race(8,i=>createOrder(pools[i%4],buyer('buyer-1'),{requestId,quantity:2}));
    assert.deepEqual(same.map(errorCode).filter(Boolean),[]);
    assert.equal(new Set(same.map(r=>(r as PromiseFulfilledResult<any>).value.order.id)).size,1);
    const conflict=randomUUID();
    const mixed=await race(8,i=>createOrder(pools[i%4],buyer('buyer-2'),{requestId:conflict,quantity:i%2?1:2}));
    const winners=mixed.filter(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>[];
    assert.equal(new Set(winners.map(r=>r.value.order.id)).size,1);
    assert.ok(mixed.map(errorCode).filter(Boolean).every(c=>c==='KEY_REUSE'));
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM demo_orders')).rows[0].n,2);
    assert.deepEqual(await assertMarketInvariants(t.db),[]);
  }finally{await t.close();}
});
test('cancel, reaper, webhook and create interleaved across connections: no deadlock, no stray hold',opts,async()=>{
  const t=await createTestDatabase();
  try{
    const buyers=Array.from({length:6},(_,i)=>`mixer-${i}`);
    await seedMarket(t.db,{groups:20,perGroup:10,buyers});
    const pools=Array.from({length:8},()=>t.connect());
    const pool=(i:number)=>pools[i%pools.length];
    const failures:string[]=[],outcomes=new Set<string>();
    // A cancel that loses to a payment finds the order already fulfilled; that is the expected answer, not a failure.
    const expected=new Set(['BUYER_LIMIT','ORDER_NOT_CANCELLABLE']);
    const note=(results:PromiseSettledResult<unknown>[])=>{
      for(const r of results){
        const c=errorCode(r);if(c&&!expected.has(c))failures.push(c);
        // The webhook handler answers instead of throwing: a 5xx is a rolled-back apply, e.g. a deadlock victim.
        const v=r.status==='fulfilled'?r.value as {status?:number;code?:string;outcome?:string}:undefined;
        if(v?.status&&v.status>=500)failures.push(`webhook ${v.status} ${v.code}`);if(v?.outcome)outcomes.add(v.outcome);
      }
    };
    for(let round=0;round<6;round++){
      const created=await race(buyers.length*2,i=>createOrder(pool(i),buyer(buyers[i%buyers.length]),{requestId:randomUUID(),quantity:1+(i+round)%3}));
      note(created);
      const placed=created.flatMap((r,i)=>r.status==='fulfilled'&&r.value.order.state==='RESERVED'?[{id:r.value.order.id,owner:buyers[i%buyers.length],view:r.value}]:[]);
      // Expire a third of the reservations behind the market's back; cancel another third (twice, concurrently); start payment
      // on the rest and deliver their success webhooks while half of those are being cancelled. Reapers and new orders join in.
      await t.db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=ANY($1::uuid[])`,[placed.filter((_,i)=>i%3===0).map(o=>o.id)]);
      const cancels=placed.filter((_,i)=>i%3===1),paid=placed.filter((_,i)=>i%3===2);
      const refs=[];for(const o of paid)refs.push((await startPaymentAttempt(t.db,buyer(o.owner),o.id,{acceptSnapshotHash:o.view.snapshotHash})).providerRef);
      const webhook=(ref:string,i:number)=>handlePaymentEvent(pool(i),signedDelivery(config,eventBody({id:`evt_${randomUUID()}`,type:'payment.succeeded',providerRef:ref,amountPaise:BigInt(paid[i].view.order.payablePaise),currency:'INR'})),config);
      const work:(()=>Promise<unknown>)[]=[
        ...cancels.flatMap((o,i)=>[()=>cancelOrder(pool(i),buyer(o.owner),o.id),()=>cancelOrder(pool(i+1),buyer(o.owner),o.id)]),
        ...refs.map((ref,i)=>()=>webhook(ref,i)),
        ...paid.filter((_,i)=>i%2===0).map((o,i)=>()=>cancelOrder(pool(i+2),buyer(o.owner),o.id)),
        ...Array.from({length:4},(_,i)=>()=>withScenarioLock(pool(i),'market',(tx,asOf)=>reapExpired(tx,'market',asOf))),
        ...buyers.map((b,i)=>()=>createOrder(pool(i+3),buyer(b),{requestId:randomUUID(),quantity:1})),
      ];
      note(await race(work.length,i=>work[i]()));
    }
    assert.deepEqual(failures,[],'no deadlock (40P01) and no unexpected error');
    assert.ok(outcomes.has('FULFILLED'),`payments were applied in the mix (${[...outcomes]})`);
    assert.deepEqual(await assertMarketInvariants(t.db,{lapseGraceSeconds:3600}),[]);
  }finally{await t.close();}
});
test('simulate called while the scenario lock is held waits for it (misuse): why simulate commits its prelude before delivering',opts,async()=>{
  const t=await createTestDatabase();
  try{
    await seedMarket(t.db,{groups:5,perGroup:10});
    const v=await createOrder(t.db,buyer('buyer-1'),{requestId:randomUUID(),quantity:1});
    await startPaymentAttempt(t.db,buyer('buyer-1'),v.order.id,{acceptSnapshotHash:v.snapshotHash});
    const presenter={id:'presenter',scenarioId:'market',role:'agent'};
    let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
    // Stands in for a caller that holds the lock (an open market transaction) and then asks the simulator to deliver.
    const holding=withScenarioLock(t.connect(),'market',async()=>{await held;});
    await sleep(100);
    let settled=false;
    const delivery=simulate(t.connect(),presenter,v.order.id,'success',config).finally(()=>{settled=true;});
    await sleep(1500);
    // Postgres cannot see this wait as a deadlock: if the holder were waiting for the delivery, neither would ever finish.
    assert.equal(settled,false,'the simulator, and the handler it calls, wait for the held scenario lock');
    release();await holding;
    const result=await delivery;
    assert.equal('outcome' in result?result.outcome:undefined,'FULFILLED','once the lock is free the delivery applies normally');
    assert.deepEqual(await assertMarketInvariants(t.db),[]);
  }finally{await t.close();}
});
test('asOf is read after the lock is acquired, so a long lock wait does not shorten a reservation',opts,async()=>{
  const t=await createTestDatabase();
  try{
    await seedMarket(t.db,{groups:5,perGroup:10});
    const blocker=t.connect(),buyerPool=t.connect();
    let releasedAt=0;
    const holding=blocker.transaction(async tx=>{
      await tx.query(`SELECT id FROM scenarios WHERE id='market' FOR UPDATE`);
      await new Promise(r=>setTimeout(r,1500));releasedAt=Date.now();
    });
    await new Promise(r=>setTimeout(r,100));
    const started=Date.now();
    const v=await createOrder(buyerPool,buyer('buyer-1'),{requestId:randomUUID(),quantity:1});
    await holding;
    assert.ok(Date.now()-started>=1300,'the order really waited for the lock');
    // now() would be the transaction start (before the wait); clock_timestamp() after the lock is no earlier than the release.
    assert.ok(Date.parse(v.order.allocatedAt!)>=releasedAt-50,`allocatedAt ${v.order.allocatedAt} must not predate the lock release`);
  }finally{await t.close();}
});
