import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migratedPglite} from './support/pglite.js';
import {seedIssuedBatch} from './support/seed.js';
import type {Database} from '../src/kernel/database.js';
import {postEarnings} from '../src/modules/payouts/application/earnings.js';
// Database-level rules of the buyer slice (docs/22 §5). These are the guarantees that must hold even if application code is wrong.
const PRICE=100030n;
async function base(credits=3){
  const {db}=await migratedPglite();
  const s=await seedIssuedBatch(db,credits);
  await db.query(`INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('buyer-1',$1,'buyer','x'),('buyer-2',$1,'buyer','x')`,[s.scenario]);
  await db.query(`INSERT INTO demo_price_list(scenario_id,effective_from,unit_price_paise,created_by) VALUES ($1,now()-interval '1 day',$2,'seed')`,[s.scenario,PRICE.toString()]);
  return {db,s};
}
async function order(db:Database,scenario:string,over:Record<string,any>={}){
  const o={id:randomUUID(),buyer:'buyer-1',request:randomUUID(),quantity:2,allocated:2,state:'RESERVED',...over};
  await db.query(`INSERT INTO demo_orders(id,scenario_id,buyer_id,request_id,request_hash,quantity,allocated_quantity,state,unit_price_paise,price_effective_from,commission_bps,principal_paise,payable_paise,reserved_until,allocated_at)
    VALUES ($1,$2,$3,$4,'h',$5,$6,$7,$8,now()-interval '1 day',500,$9,$9,CASE WHEN $7='CREATED' THEN NULL ELSE now()+interval '5 minutes' END,CASE WHEN $7='CREATED' THEN NULL ELSE now() END)`,[o.id,scenario,o.buyer,o.request,o.quantity,o.allocated,o.state,PRICE.toString(),(PRICE*BigInt(o.allocated)).toString()]);
  return o.id as string;
}
const hold=(db:Database,orderId:string,scenario:string,creditId:string,generation=1)=>db.query(`INSERT INTO demo_order_items(order_id,scenario_id,credit_id,group_id,generation,active) SELECT $1,$2,c.id,b.capture_id,$4,true FROM demo_credits c JOIN demo_issuance_batches b ON b.id=c.batch_id WHERE c.id=$3`,[orderId,scenario,creditId,generation]);
const setCredit=(db:Database,creditId:string,state:string,orderId:string|null)=>db.query('UPDATE demo_credits SET state=$2,reserved_order_id=$3 WHERE id=$1',[creditId,state,orderId]);
const attempt=async(db:Database,orderId:string,scenario:string,amount:bigint,state='PENDING')=>{const id=randomUUID();await db.query(`INSERT INTO demo_payment_attempts(id,order_id,scenario_id,provider,provider_ref,state,amount_paise) VALUES ($1,$2,$3,'simulator',$4,$5,$6)`,[id,orderId,scenario,`ref-${id}`,state,amount.toString()]);return id;};
/** The fulfilment write set of docs/22 §6.1 step 4, in the documented order, with the earnings docs/23 §6.1 adds to it. */
async function fulfil(tx:Database,s:Awaited<ReturnType<typeof base>>['s'],orderId:string,attemptId:string,credits:string[],opts:{skipLedger?:boolean;gross?:bigint;leaveUnsold?:boolean}={}){
  for(const [i,c] of credits.entries()){
    if(!(opts.leaveUnsold&&i===0))await setCredit(tx,c,'SOLD',orderId);
    if(!(opts.skipLedger&&i===0)){
      const gross=opts.gross??PRICE;await tx.query(`INSERT INTO demo_ledger_entries(order_id,scenario_id,credit_id,payee_group_id,gross_paise,commission_paise,net_paise) VALUES ($1,$2,$3,(SELECT capture_id FROM demo_issuance_batches WHERE id=$4),$5,$6,$7)`,[orderId,s.scenario,c,s.batch,gross.toString(),'5002',(gross-5002n).toString()]);
    }
  }
  const rows=(await tx.query(`SELECT id::text AS id,payee_group_id::text AS payee,gross_paise::text AS g,commission_paise::text AS c,net_paise::text AS n FROM demo_ledger_entries WHERE order_id=$1`,[orderId])).rows;
  await postEarnings(tx,s.scenario,rows.map(r=>({ledgerEntryId:r.id,payeeGroupId:r.payee,grossPaise:BigInt(r.g),commissionPaise:BigInt(r.c),netPaise:BigInt(r.n)})));
  await tx.query(`UPDATE demo_payment_attempts SET state='SUCCEEDED' WHERE id=$1`,[attemptId]);
  await tx.query(`UPDATE demo_orders SET state='FULFILLED' WHERE id=$1`,[orderId]);
}
async function reserved(db:Database,s:{scenario:string;creditIds:string[]},n=2){
  const id=await order(db,s.scenario,{allocated:n,quantity:n});
  for(const c of s.creditIds.slice(0,n)){await hold(db,id,s.scenario,c);await setCredit(db,c,'RESERVED',id);}
  return id;
}
test('the buyer role is accepted and unknown roles are still rejected',async()=>{
  const {db,s}=await base();
  assert.equal((await db.query(`SELECT role FROM users WHERE id='buyer-1'`)).rows[0].role,'buyer');
  await assert.rejects(db.query(`INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('x',$1,'admin','x')`,[s.scenario]));
});
test('the price list is positive and insert-only',async()=>{
  const {db,s}=await base();
  await assert.rejects(db.query(`INSERT INTO demo_price_list(scenario_id,effective_from,unit_price_paise,created_by) VALUES ($1,now(),0,'seed')`,[s.scenario]));
  await assert.rejects(db.query(`UPDATE demo_price_list SET unit_price_paise=1`));await assert.rejects(db.query('DELETE FROM demo_price_list'));
});
test('order amounts, quantities and the request key are constrained',async()=>{
  const {db,s}=await base();
  const request=randomUUID();await order(db,s.scenario,{request});
  await assert.rejects(order(db,s.scenario,{request}),'same buyer, same request id');
  await order(db,s.scenario,{request,buyer:'buyer-2'});
  await assert.rejects(order(db,s.scenario,{quantity:0,allocated:0}));await assert.rejects(order(db,s.scenario,{quantity:101,allocated:101}));
  await assert.rejects(order(db,s.scenario,{quantity:2,allocated:3}),'allocated cannot exceed requested');
  await assert.rejects(db.query(`UPDATE demo_orders SET principal_paise=principal_paise+1 WHERE request_id=$1 AND buyer_id='buyer-1'`,[request]),'principal must equal price x allocated');
  await order(db,s.scenario,{quantity:3,allocated:1});
});
test('order states follow the machine; terminal states have no exit; identity is immutable',async()=>{
  const {db,s}=await base();
  const move=(id:string,state:string)=>db.query('UPDATE demo_orders SET state=$2 WHERE id=$1',[id,state]);
  const a=await order(db,s.scenario);
  for(const next of ['AWAITING_PAYMENT','EXPIRED','REVALIDATING','REFUND_PENDING','REFUNDED'])await move(a,next);
  for(const next of ['RESERVED','FULFILLED','CANCELLED','REVALIDATING'])await assert.rejects(move(a,next),new RegExp('illegal'),`REFUNDED -> ${next}`);
  const b=await order(db,s.scenario,{state:'CREATED',allocated:0});
  await assert.rejects(move(b,'FULFILLED'));await assert.rejects(move(b,'AWAITING_PAYMENT'));
  // An offer becomes a reservation together with its deadline (0007 ties the timestamps to the state).
  await db.query(`UPDATE demo_orders SET state='RESERVED',reserved_until=now()+interval '5 minutes',allocated_at=now() WHERE id=$1`,[b]);await move(b,'CANCELLED');
  await move(b,'REVALIDATING');await move(b,'REFUND_PENDING');
  const c=await order(db,s.scenario);await move(c,'AWAITING_PAYMENT');await move(c,'RESERVED');await move(c,'CANCELLED');await assert.rejects(move(c,'EXPIRED'));
  await assert.rejects(db.query(`UPDATE demo_orders SET buyer_id='buyer-2' WHERE id=$1`,[c]));await assert.rejects(db.query(`UPDATE demo_orders SET quantity=5 WHERE id=$1`,[c]));
  await assert.rejects(db.query('DELETE FROM demo_orders WHERE id=$1',[c]));
  await assert.rejects(order(db,s.scenario,{state:'FULFILLED'}),'orders are created CREATED or RESERVED');
});
test('payment attempts: success is absorbing, a captured payment can follow a failure, the amount is fixed',async()=>{
  const {db,s}=await base();const o=await order(db,s.scenario);
  const move=(id:string,state:string)=>db.query('UPDATE demo_payment_attempts SET state=$2 WHERE id=$1',[id,state]);
  const a=await attempt(db,o,s.scenario,PRICE*2n,'CREATED');await move(a,'PENDING');await move(a,'FAILED');await move(a,'SUCCEEDED');
  for(const next of ['FAILED','CANCELLED','PENDING','CREATED'])await assert.rejects(move(a,next),/illegal/,`SUCCEEDED -> ${next}`);
  const b=await attempt(db,o,s.scenario,PRICE*2n,'CREATED');await move(b,'CANCELLED');await assert.rejects(move(b,'PENDING'));await move(b,'SUCCEEDED');
  await assert.rejects(db.query(`UPDATE demo_payment_attempts SET amount_paise=1 WHERE id=$1`,[b]));await assert.rejects(db.query(`UPDATE demo_payment_attempts SET provider_ref='x' WHERE id=$1`,[b]));
  await assert.rejects(db.query('DELETE FROM demo_payment_attempts WHERE id=$1',[b]));
  const dup=await db.query(`SELECT provider_ref FROM demo_payment_attempts WHERE id=$1`,[b]);
  await assert.rejects(db.query(`INSERT INTO demo_payment_attempts(id,order_id,scenario_id,provider,provider_ref,state,amount_paise) VALUES ($1,$2,$3,'simulator',$4,'CREATED',1)`,[randomUUID(),o,s.scenario,dup.rows[0].provider_ref]));
});
test('a credit can be actively held by only one order; items only ever deactivate',async()=>{
  const {db,s}=await base();
  const [c1,c2]=s.creditIds,a=await order(db,s.scenario,{allocated:1,quantity:1}),b=await order(db,s.scenario,{allocated:1,quantity:1});
  await hold(db,a,s.scenario,c1);
  await assert.rejects(hold(db,b,s.scenario,c1),'a second active hold on the same credit');
  await assert.rejects(hold(db,a,s.scenario,c1,2),'the same order twice for one credit');
  await hold(db,b,s.scenario,c2);
  await db.query('UPDATE demo_order_items SET active=false WHERE order_id=$1',[a]);
  await hold(db,b,s.scenario,c1);
  await assert.rejects(db.query('UPDATE demo_order_items SET active=true WHERE order_id=$1 AND credit_id=$2',[a,c1]),'old generations are never reactivated');
  await assert.rejects(db.query(`UPDATE demo_order_items SET credit_id=$2 WHERE order_id=$1 AND active`,[b,s.creditIds[2]]));
  await assert.rejects(db.query('DELETE FROM demo_order_items WHERE order_id=$1',[a]));
});
test('credit guard: reserving needs an active hold, release needs none, sold needs a payable order',async()=>{
  const {db,s}=await base();
  const [c1,c2]=s.creditIds,o=await order(db,s.scenario,{allocated:1,quantity:1}),other=await order(db,s.scenario,{allocated:1,quantity:1});
  await assert.rejects(setCredit(db,c1,'RESERVED',o),/active|hold/i,'no item yet');
  await assert.rejects(db.query(`UPDATE demo_credits SET state='RESERVED' WHERE id=$1`,[c1]),'reserved needs an owner');
  await hold(db,o,s.scenario,c1);
  await assert.rejects(setCredit(db,c1,'RESERVED',other),'the hold belongs to a different order');
  await setCredit(db,c1,'RESERVED',o);
  await assert.rejects(setCredit(db,c1,'AVAILABLE',null),/active|hold/i,'release before the hold is deactivated');
  await db.query('UPDATE demo_order_items SET active=false WHERE order_id=$1',[o]);
  await setCredit(db,c1,'AVAILABLE',null);
  await assert.rejects(db.query(`UPDATE demo_credits SET reserved_order_id=$2 WHERE id=$1`,[c1,o]),'an available credit has no owner');
  await assert.rejects(db.query(`UPDATE demo_credits SET available_since=now() WHERE id=$1`,[c2]),'available_since is set once');
  // SOLD only for an order that is payable.
  await hold(db,other,s.scenario,c2);await setCredit(db,c2,'RESERVED',other);
  await db.query(`UPDATE demo_orders SET state='EXPIRED' WHERE id=$1`,[other]);
  await assert.rejects(setCredit(db,c2,'SOLD',other),/payable|order state/i,'an expired order cannot sell a credit');
  await db.query(`UPDATE demo_orders SET state='REVALIDATING' WHERE id=$1`,[other]);
  await setCredit(db,c2,'SOLD',other);
});
test('fulfilment commits only when items, credits, ledger and totals agree',async()=>{
  // Happy path.
  {
    const {db,s}=await base();const o=await reserved(db,s,2),a=await attempt(db,o,s.scenario,PRICE*2n);
    await db.transaction(tx=>fulfil(tx,s,o,a,s.creditIds.slice(0,2)));
    assert.equal((await db.query('SELECT state FROM demo_orders WHERE id=$1',[o])).rows[0].state,'FULFILLED');
    await assert.rejects(db.query(`UPDATE demo_orders SET state='REFUNDED' WHERE id=$1`,[o]),'FULFILLED has no exit');
  }
  // Each inconsistency is rejected at commit and rolls the whole transaction back.
  for(const [name,opts] of [['missing ledger row',{skipLedger:true}],['gross differs from price',{gross:PRICE+1n}],['a credit left unsold',{leaveUnsold:true}]] as const){
    const {db,s}=await base();const o=await reserved(db,s,2),a=await attempt(db,o,s.scenario,PRICE*2n);
    await assert.rejects(db.transaction(tx=>fulfil(tx,s,o,a,s.creditIds.slice(0,2),opts)),`${name} must fail at commit`);
    assert.equal((await db.query('SELECT state FROM demo_orders WHERE id=$1',[o])).rows[0].state,'RESERVED',name);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM demo_ledger_entries')).rows[0].n,0,name);
  }
});
test('ledger rows balance, are one per credit, are append-only, and exist only through fulfilment',async()=>{
  const {db,s}=await base();const o=await reserved(db,s,1),a=await attempt(db,o,s.scenario,PRICE);
  await db.transaction(tx=>fulfil(tx,s,o,a,s.creditIds.slice(0,1)));
  const insert=(gross:string,commission:string,net:string,credit=s.creditIds[0])=>db.query(`INSERT INTO demo_ledger_entries(order_id,scenario_id,credit_id,payee_group_id,gross_paise,commission_paise,net_paise) VALUES ($1,$2,$3,$4,$5,$6,$7)`,[o,s.scenario,credit,s.capture,gross,commission,net]);
  await assert.rejects(insert('100030','5002','95027',s.creditIds[1]));await assert.rejects(insert('-1','0','-1',s.creditIds[1]));
  await assert.rejects(insert('100030','5002','95028'),/unique|duplicate/,'a credit is posted once');
  // 0009: a row outside fulfilment breaks its order's totals and has no earnings, so it never commits.
  await assert.rejects(insert('100030','5002','95028',s.creditIds[1]),/order|EARN/);
  await assert.rejects(db.query('UPDATE demo_ledger_entries SET net_paise=0'));await assert.rejects(db.query('DELETE FROM demo_ledger_entries'));
});
test('payment events and refunds: idempotency key, fixed outcomes, append-only, refund once per kind',async()=>{
  const {db,s}=await base();const o=await order(db,s.scenario),a=await attempt(db,o,s.scenario,PRICE*2n);
  const event=(id:string,outcome='FULFILLED',hash='h')=>db.query(`INSERT INTO demo_payment_events(provider,provider_event_id,attempt_id,scenario_id,type,payload_hash,amount_paise,outcome) VALUES ('simulator',$1,$2,$3,'payment.succeeded',$4,$5,$6)`,[id,a,s.scenario,hash,(PRICE*2n).toString(),outcome]);
  await event('evt-1');await assert.rejects(event('evt-1'),'the provider event id is the idempotency key');
  await assert.rejects(event('evt-2','MADE_UP'));
  for(const outcome of ['FULFILLED','REVALIDATED_FULFILLED','REFUND_LATE_UNFILLABLE','REFUND_DUPLICATE_ATTEMPT','AMOUNT_MISMATCH','ATTEMPT_UPDATED','IGNORED_SAME_ATTEMPT','IGNORED_TERMINAL'])await event(`evt-${outcome}`,outcome);
  await assert.rejects(db.query(`UPDATE demo_payment_events SET outcome='IGNORED_TERMINAL'`));await assert.rejects(db.query('DELETE FROM demo_payment_events'));
  const refund=(kind:string)=>db.query(`INSERT INTO demo_payment_refunds(order_id,attempt_id,scenario_id,kind,amount_paise) VALUES ($1,$2,$3,$4,$5)`,[o,a,s.scenario,kind,(PRICE*2n).toString()]);
  await refund('LATE_UNFILLABLE');await assert.rejects(refund('LATE_UNFILLABLE'),'one refund per attempt and kind');await refund('DUPLICATE_ATTEMPT');await assert.rejects(refund('SOMETHING'));
  await db.query(`UPDATE demo_payment_refunds SET state='REFUNDED' WHERE kind='LATE_UNFILLABLE'`);
  await assert.rejects(db.query(`UPDATE demo_payment_refunds SET state='PENDING' WHERE kind='LATE_UNFILLABLE'`),'REFUNDED is final');
  await assert.rejects(db.query(`UPDATE demo_payment_refunds SET amount_paise=1`));await assert.rejects(db.query('DELETE FROM demo_payment_refunds'));
});
