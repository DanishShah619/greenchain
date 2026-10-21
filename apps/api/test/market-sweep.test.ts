import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migratedPglite} from './support/pglite.js';
import {seedMarket,buyer,PRICE} from './support/market.js';
import {createOrder,getOrder} from '../src/modules/market/application/orders.js';
import {DEFAULT_PAYMENTS,handlePaymentEvent,startPaymentAttempt} from '../src/modules/market/application/payments.js';
import {eventBody,signedDelivery} from '../src/modules/market/infrastructure/simulator.js';
import {DEFAULT_SWEEP,marketSweep,newSweepState,sweepConfigFromEnvironment,type SweepConfig} from '../src/modules/market/application/sweep.js';
import {observeScenarioLockWait} from '../src/modules/market/application/lock.js';
import {declareMarketApiMetrics,declareMarketWorkerMetrics} from '../src/modules/market/application/metrics.js';
import {declareWorkerMetrics,newHealthState,workerCycle} from '../src/modules/ops/application/iteration.js';
import {startOpsServer} from '../src/bootstrap/ops-server.js';
import {buildApp} from '../src/bootstrap/app.js';
import {DEFAULT_MARKET} from '../src/modules/market/application/orders.js';
import {WEBHOOK_PATH} from '../src/modules/market/http/routes.js';
import {hashPassword} from '../src/kernel/password.js';
import {Metrics} from '../src/kernel/metrics.js';
import type {Logger} from '../src/kernel/logger.js';
import type {Database} from '../src/kernel/database.js';
const payments={...DEFAULT_PAYMENTS,secrets:['sweep-test-webhook-secret-32-chars-long']};
const b1=buyer('buyer-1'),b2=buyer('buyer-2');
function recorder(){const lines:{level:string;message:string;fields:Record<string,unknown>}[]=[];
  const at=(level:string)=>(fields:Record<string,unknown>,message:string)=>{lines.push({level,message,fields});};
  return {lines,log:{debug:at('debug'),info:at('info'),warn:at('warn'),error:at('error')} as Logger};}
const metricValue=(m:Metrics,line:string)=>{const hit=m.render().split('\n').find(l=>l.startsWith(line+' '));return hit===undefined?undefined:Number(hit.slice(line.length+1));};
async function market(){const {db}=await migratedPglite();await seedMarket(db,{groups:20,perGroup:10});return db;}
async function lateRefund(db:Database){
  // An order whose payment arrives after its credit was taken: a LATE_UNFILLABLE refund is owed.
  const v=await createOrder(db,b1,{requestId:randomUUID(),quantity:1});
  const p=await startPaymentAttempt(db,b1,v.order.id,{acceptSnapshotHash:v.snapshotHash});
  await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[v.order.id]);
  await createOrder(db,b2,{requestId:randomUUID(),quantity:1});
  const r=await handlePaymentEvent(db,signedDelivery(payments,eventBody({id:`evt_${randomUUID()}`,type:'payment.succeeded',providerRef:p.providerRef,amountPaise:PRICE,currency:'INR'})),payments);
  assert.equal(r.outcome,'REFUND_LATE_UNFILLABLE');return v.order.id;
}
test('the sweep expires lapsed reservations and settles refunds only after the visible delay',async()=>{
  const db=await market(),metrics=new Metrics();declareMarketWorkerMetrics(metrics);
  const config:SweepConfig={...DEFAULT_SWEEP,refundSettleAfterSeconds:600},state=newSweepState();
  const lapsed=await createOrder(db,b1,{requestId:randomUUID(),quantity:2});
  await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[lapsed.order.id]);
  const refunded=await lateRefund(db);
  let r=await marketSweep(db,{config,state,metrics});
  assert.equal(r.expired,0,'lateRefund already reaped through order creation');
  assert.equal(r.refundsSettled,0,'a fresh refund stays visible as REFUND_PENDING');
  assert.equal((await getOrder(db,b1,refunded)).order.state,'REFUND_PENDING');
  assert.equal(metricValue(metrics,'greenchain_refunds_pending'),1);
  // Age the refund past the delay, and let a reservation and a shortfall offer go stale.
  await db.query(`UPDATE demo_payment_refunds SET created_at=now()-interval '11 minutes'`);
  const fresh=await createOrder(db,b2,{requestId:randomUUID(),quantity:1});
  await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[fresh.order.id]);
  r=await marketSweep(db,{config,state,metrics});
  assert.equal(r.expired,1);assert.equal(r.refundsSettled,1);assert.equal(r.worked,true);
  assert.equal((await getOrder(db,b1,refunded)).order.state,'REFUNDED');assert.equal((await getOrder(db,b2,fresh.order.id)).order.state,'EXPIRED');
  assert.equal(metricValue(metrics,'greenchain_reservations_reaped_total'),1);assert.equal(metricValue(metrics,'greenchain_refunds_settled_total'),1);
  assert.equal(metricValue(metrics,'greenchain_refunds_pending'),0);assert.equal(metricValue(metrics,'greenchain_orders{state="EXPIRED"}'),2);
  assert.equal(metricValue(metrics,'greenchain_payment_events{outcome="REFUND_LATE_UNFILLABLE"}'),1);
  r=await marketSweep(db,{config,state,metrics});assert.equal(r.worked,false,'nothing left to do');
});
test('an idle sweep takes no scenario lock, so it never contends with buyers',async()=>{
  const db=await market();let locks=0;
  observeScenarioLockWait(()=>{locks++;});
  try{
    await createOrder(db,b1,{requestId:randomUUID(),quantity:1});const before=locks;
    for(let i=0;i<3;i++)await marketSweep(db,{config:DEFAULT_SWEEP,state:newSweepState()});
    assert.equal(locks,before,'no lock without due work');
    await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second'`);
    await marketSweep(db,{config:DEFAULT_SWEEP,state:newSweepState()});assert.equal(locks,before+1);
  }finally{observeScenarioLockWait(undefined);}
});
test('refund settlement can be left to the presenter entirely',async()=>{
  const db=await market();const refunded=await lateRefund(db);
  await db.query(`UPDATE demo_payment_refunds SET created_at=now()-interval '2 days'`);
  await marketSweep(db,{config:{...DEFAULT_SWEEP,refundSettleAfterSeconds:null},state:newSweepState()});
  assert.equal((await getOrder(db,b1,refunded)).order.state,'REFUND_PENDING');
});
test('invariants run on schedule, a violation is reported once in metrics and logs, and recovery is logged',async()=>{
  const db=await market(),metrics=new Metrics();declareMarketWorkerMetrics(metrics);
  const {lines,log}=recorder(),state=newSweepState();let clock=1_000_000;const now=()=>clock;
  const config={...DEFAULT_SWEEP,invariantEverySeconds:60};
  assert.deepEqual((await marketSweep(db,{config,state,metrics,log,now})).violations,[]);
  assert.equal(metricValue(metrics,'greenchain_market_invariant_violations{code="SOLD_WITHOUT_FULFILMENT"}'),0);
  // Plant a credit marked SOLD for an order that was never paid, bypassing the guard (as a bug or manual fix might).
  const v=await createOrder(db,b1,{requestId:randomUUID(),quantity:1});
  await db.query('ALTER TABLE demo_credits DISABLE TRIGGER demo_credits_guard');
  await db.query(`UPDATE demo_credits SET state='SOLD' WHERE id=$1`,[v.items[0].creditId]);
  clock+=30_000;assert.equal((await marketSweep(db,{config,state,metrics,log,now})).violations,undefined,'not due yet');
  clock+=31_000;assert.deepEqual((await marketSweep(db,{config,state,metrics,log,now})).violations?.map(x=>x.code),['SOLD_WITHOUT_FULFILMENT']);
  assert.equal(metricValue(metrics,'greenchain_market_invariant_violations{code="SOLD_WITHOUT_FULFILMENT"}'),1);
  clock+=61_000;await marketSweep(db,{config,state,metrics,log,now});
  assert.equal(lines.filter(l=>l.message==='Market invariant violated').length,1,'the same finding is logged once, not every check');
  assert.deepEqual(lines.find(l=>l.message==='Market invariant violated')?.fields.examples,[v.items[0].creditId]);
  await db.query(`UPDATE demo_credits SET state='RESERVED' WHERE id=$1`,[v.items[0].creditId]);
  await db.query('ALTER TABLE demo_credits ENABLE TRIGGER demo_credits_guard');
  clock+=61_000;assert.deepEqual((await marketSweep(db,{config,state,metrics,log,now})).violations,[]);
  assert.equal(metricValue(metrics,'greenchain_market_invariant_violations{code="SOLD_WITHOUT_FULFILMENT"}'),0);
  assert.equal(lines.filter(l=>l.message==='Market invariants hold again').length,1);
});
test('the worker cycle runs the market sweep, and a market failure is isolated from chaining',async()=>{
  const db=await market(),metrics=new Metrics();declareWorkerMetrics(metrics);const {lines,log}=recorder();
  const deps={db,log,metrics,health:newHealthState('test'),market:{config:DEFAULT_SWEEP,state:newSweepState()}};
  await createOrder(db,b1,{requestId:randomUUID(),quantity:2});
  assert.equal((await workerCycle(deps)).ok,true);
  assert.equal(metricValue(metrics,'greenchain_orders{state="RESERVED"}'),1);
  await db.query('ALTER TABLE demo_payment_refunds RENAME TO demo_payment_refunds_gone');
  const outcome=await workerCycle(deps);
  assert.equal(outcome.ok,true,'chaining and proofs still count as a healthy cycle');
  assert.equal(metricValue(metrics,'greenchain_market_sweep_failures_total'),1);
  assert.ok(lines.some(l=>l.level==='error'&&l.message==='Market sweep failed'));
  await db.query('ALTER TABLE demo_payment_refunds_gone RENAME TO demo_payment_refunds');
});
test('API metrics count order results, webhook outcomes and rejections, and scenario lock waits',async()=>{
  const {db,pg}=await migratedPglite();await seedMarket(db,{scenario:'presenter',groups:20,perGroup:10,buyers:['buyer']});
  await db.query(`UPDATE users SET password_hash=$1 WHERE id='buyer'`,[hashPassword('metrics-test-password-123')]);
  const metrics=new Metrics();declareMarketApiMetrics(metrics);
  observeScenarioLockWait(s=>{metrics.inc('greenchain_scenario_lock_wait_seconds_total',{},s);metrics.inc('greenchain_scenario_lock_acquisitions_total');});
  const origin='http://localhost:3000';
  const app=await buildApp(db,{origin,secure:false,market:{market:DEFAULT_MARKET,payments,demoMode:true,metrics}});
  await db.query(`INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('presenter','presenter','agent',$1)`,[hashPassword('metrics-test-password-123')]);
  try{
    const login=await app.inject({method:'POST',url:'/api/v1/session',headers:{origin},payload:{account:'buyer',password:'metrics-test-password-123'}});
    const headers={origin,cookie:`session=${login.cookies[0].value}`,'x-csrf-token':login.json().csrf};
    const order=(await app.inject({method:'POST',url:'/api/v1/orders',headers,payload:{requestId:randomUUID(),quantity:2}})).json();
    await app.inject({method:'POST',url:'/api/v1/orders',headers,payload:{requestId:randomUUID(),quantity:50}});
    assert.equal(metricValue(metrics,'greenchain_orders_created_total{result="reserved"}'),1);
    assert.equal(metricValue(metrics,'greenchain_orders_created_total{result="BUYER_LIMIT"}'),1);
    const pay=(await app.inject({method:'POST',url:`/api/v1/orders/${order.order.id}/payment-attempts`,headers,payload:{acceptSnapshotHash:order.snapshotHash}})).json();
    const post=(d:{body:Buffer;timestamp:string;signature:string},sig=d.signature)=>app.inject({method:'POST',url:WEBHOOK_PATH,headers:{'content-type':'application/json','x-greenchain-timestamp':d.timestamp,'x-greenchain-signature':sig},payload:d.body});
    const d=signedDelivery(payments,eventBody({id:'evt_metrics',type:'payment.succeeded',providerRef:pay.providerRef,amountPaise:PRICE*2n,currency:'INR'}));
    await post(d,'0'.repeat(64));await post(d);await post(d);
    assert.equal(metricValue(metrics,'greenchain_webhook_rejected_total{reason="WEBHOOK_SIGNATURE"}'),1);
    assert.equal(metricValue(metrics,'greenchain_payment_events_applied_total{outcome="FULFILLED"}'),2,'applied once, replayed once');
    assert.equal(metricValue(metrics,'greenchain_webhook_requests_total{status="200"}'),2);
    // A presenter-simulated delivery is counted too, although it bypasses the webhook route.
    const p=await app.inject({method:'POST',url:'/api/v1/session',headers:{origin},payload:{account:'presenter',password:'metrics-test-password-123'}});
    const presenter={origin,cookie:`session=${p.cookies[0].value}`,'x-csrf-token':p.json().csrf};
    assert.equal((await app.inject({method:'POST',url:`/api/v1/demo/orders/${order.order.id}/simulate`,headers:presenter,payload:{outcome:'replay'}})).json().outcome,'FULFILLED');
    assert.equal(metricValue(metrics,'greenchain_payment_events_applied_total{outcome="FULFILLED"}'),3);
    assert.ok((metricValue(metrics,'greenchain_scenario_lock_acquisitions_total')??0)>=4);
    assert.ok((metricValue(metrics,'greenchain_scenario_lock_wait_seconds_total')??-1)>=0);
    assert.doesNotMatch(metrics.render(),/evt_metrics|sim_|buyer/,'no ids or user data in labels');
  }finally{observeScenarioLockWait(undefined);await app.close();await pg.close();}
});
test('an ops server without a health state serves metrics and a plain health check',async()=>{
  const metrics=new Metrics();declareMarketApiMetrics(metrics);
  const server=await startOpsServer({port:0,host:'127.0.0.1',metrics});
  try{
    const h=await fetch(`http://127.0.0.1:${server.port}/healthz`);assert.equal(h.status,200);assert.deepEqual(await h.json(),{status:'ok'});
    assert.match(await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text(),/greenchain_webhook_requests_total/);
  }finally{await server.close();}
});
test('sweep settings from the environment are validated',()=>{
  assert.deepEqual(sweepConfigFromEnvironment(DEFAULT_MARKET,{}),DEFAULT_SWEEP);
  assert.equal(sweepConfigFromEnvironment(DEFAULT_MARKET,{MARKET_REFUND_SETTLE_SECONDS:'off'}).refundSettleAfterSeconds,null);
  assert.equal(sweepConfigFromEnvironment(DEFAULT_MARKET,{MARKET_REFUND_SETTLE_SECONDS:'0'}).refundSettleAfterSeconds,0);
  assert.throws(()=>sweepConfigFromEnvironment(DEFAULT_MARKET,{MARKET_INVARIANT_EVERY_SECONDS:'5'}));
  assert.throws(()=>sweepConfigFromEnvironment(DEFAULT_MARKET,{MARKET_LAPSE_GRACE_SECONDS:'x'}));
});
