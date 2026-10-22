import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migratedPglite} from './support/pglite.js';
import {seedMarket,buyer,PRICE} from './support/market.js';
import {createOrder} from '../src/modules/market/application/orders.js';
import {DEFAULT_PAYMENTS,handlePaymentEvent,startPaymentAttempt,type PaymentConfig} from '../src/modules/market/application/payments.js';
import {eventBody,signedDelivery} from '../src/modules/market/infrastructure/simulator.js';
import {assertMarketInvariants} from '../src/modules/market/application/invariants.js';
import type {Database} from '../src/kernel/database.js';
const config:PaymentConfig={...DEFAULT_PAYMENTS,secrets:['test-webhook-secret-current']};
const b1=buyer('buyer-1'),b2=buyer('buyer-2');
const codes=async(db:Database)=>(await assertMarketInvariants(db,{lapseGraceSeconds:3600})).map(v=>v.code);
function succeed(db:Database,providerRef:string,amount:bigint){
  return handlePaymentEvent(db,signedDelivery(config,eventBody({id:`evt_${randomUUID()}`,type:'payment.succeeded',providerRef,amountPaise:amount,currency:'INR'})),config);
}
/** A captured payment the market never accounted for: an applied success with no matching refund (as if a refund insert were lost). */
const strandedCapture=(db:Database,attemptId:string,amount:bigint)=>db.query(`INSERT INTO demo_payment_events(provider,provider_event_id,attempt_id,scenario_id,type,payload_hash,amount_paise,outcome)
  VALUES ('simulator',$1,$2,'market','payment.succeeded','h',$3,'AMOUNT_MISMATCH')`,[`evt_${randomUUID()}`,attemptId,String(amount)]);
test('invariant 5: a refunded order sold nothing and its refunds sum to the captured amount',async()=>{
  const {db}=await migratedPglite();await seedMarket(db,{groups:1,perGroup:10});
  const v=await createOrder(db,b1,{requestId:randomUUID(),quantity:1});
  const paying=await startPaymentAttempt(db,b1,v.order.id,{acceptSnapshotHash:v.snapshotHash});
  // The reservation lapses and another buyer takes the credit, so the payment arrives too late and is refunded in full.
  await db.query(`UPDATE demo_orders SET reserved_until=now()-interval '1 second' WHERE id=$1`,[v.order.id]);
  await createOrder(db,b2,{requestId:randomUUID(),quantity:1});
  assert.equal((await succeed(db,paying.providerRef,PRICE)).outcome,'REFUND_LATE_UNFILLABLE');
  assert.deepEqual(await codes(db),[]);
  await strandedCapture(db,paying.attemptId,500n);
  assert.deepEqual(await assertMarketInvariants(db,{lapseGraceSeconds:3600}),[{code:'CAPTURE_NOT_ACCOUNTED',ref:v.order.id}]);
});
test('captured money is accounted for on every order: the fulfilled amount plus refunds',async()=>{
  const {db}=await migratedPglite();await seedMarket(db,{groups:5,perGroup:10});
  const v=await createOrder(db,b1,{requestId:randomUUID(),quantity:2});
  const paying=await startPaymentAttempt(db,b1,v.order.id,{acceptSnapshotHash:v.snapshotHash});
  assert.equal((await succeed(db,paying.providerRef,PRICE*2n)).outcome,'FULFILLED');
  assert.equal((await succeed(db,paying.providerRef,PRICE)).outcome,'AMOUNT_MISMATCH');
  assert.deepEqual(await codes(db),[],'captured 3 x price = fulfilled 2 x price + refunded 1 x price');
  await strandedCapture(db,paying.attemptId,PRICE);
  assert.deepEqual(await codes(db),['CAPTURE_NOT_ACCOUNTED']);
});
