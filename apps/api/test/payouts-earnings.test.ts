import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Database} from '../src/kernel/database.js';
import {createOrder,DEFAULT_MARKET,type MarketConfig} from '../src/modules/market/application/orders.js';
import {DEFAULT_PAYMENTS,handlePaymentEvent,startPaymentAttempt,type PaymentConfig} from '../src/modules/market/application/payments.js';
import {eventBody,signedDelivery} from '../src/modules/market/infrastructure/simulator.js';
import {assertMarketInvariants} from '../src/modules/market/application/invariants.js';
import {commissionPaise} from '../src/modules/market/domain/money.js';
import {earningJournals,payoutBatched} from '../src/modules/payouts/domain/postings.js';
import {sandboxToken,DEFAULT_LEDGER_CONFIG} from '../src/modules/payouts/domain/config.js';
import {advanceClock,simNow} from '../src/modules/payouts/application/clock.js';
import {postJournals} from '../src/modules/payouts/application/journal.js';
import {postEarnings} from '../src/modules/payouts/application/earnings.js';
import {seedMarket,buyer,PRICE} from './support/market.js';
import {migratedPglite} from './support/pglite.js';
import {addBatch,addPayout,balance,sellDirect,writeJournal,type LedgerRow} from './support/payouts.js';
// Earnings at fulfilment (docs/23 §6.1, P3-P7) and the database parity that makes them unavoidable (migration 0009).
const config:PaymentConfig={...DEFAULT_PAYMENTS,secrets:['test-webhook-secret-current']};
const DAY=86_400_000,BUYERS=['buyer-1','buyer-2','buyer-3','buyer-4','buyer-5','buyer-6'];
const code=(c:string)=>(e:any)=>{assert.equal(e?.code,c);return true;};
async function setup(o:{groups?:number;perGroup?:number}={}){
  const {db}=await migratedPglite();
  const m=await seedMarket(db,{groups:o.groups??20,perGroup:o.perGroup??10,buyers:BUYERS});
  return {db,m,scenario:m.scenario};
}
let nextBuyer=0;
/** A real sale: order, payment attempt, signed provider success through the webhook handler. */
async function sell(db:Database,quantity=2,market:MarketConfig=DEFAULT_MARKET){
  const b=buyer(BUYERS[nextBuyer++%BUYERS.length]);
  const v=await createOrder(db,b,{requestId:randomUUID(),quantity},market);
  const paying=await startPaymentAttempt(db,b,v.order.id,{acceptSnapshotHash:v.snapshotHash},market);
  const body=eventBody({id:`evt_${randomUUID()}`,type:'payment.succeeded',providerRef:paying.providerRef,amountPaise:PRICE*BigInt(quantity),currency:'INR'});
  const r=await handlePaymentEvent(db,signedDelivery(config,body),config);
  assert.equal(r.outcome,'FULFILLED',JSON.stringify(r));
  return v.order.id;
}
type Earning={id:string;payee:string;g:bigint;c:bigint;n:bigint;earned:number|null;releasable:number|null;holdback:number|null;reserveBps:number|null;version:number|null;event:string|null};
async function earnings(db:Database,orderId:string):Promise<Earning[]>{
  const r=await db.query(`SELECT e.id::text AS id,e.payee_group_id::text AS payee,e.gross_paise::text AS g,e.commission_paise::text AS c,e.net_paise::text AS n,
    l.earned_sim,l.releasable_at_sim,l.holdback_days,l.reserve_bps,l.config_version,ev.state
    FROM demo_ledger_entries e LEFT JOIN demo_earning_lots l ON l.ledger_entry_id=e.id LEFT JOIN demo_lot_events ev ON ev.ledger_entry_id=e.id AND ev.seq=1
    WHERE e.order_id=$1 ORDER BY e.id`,[orderId]);
  const t=(v:unknown)=>v==null?null:new Date(v as string).getTime();
  return r.rows.map(x=>({id:x.id,payee:x.payee,g:BigInt(x.g),c:BigInt(x.c),n:BigInt(x.n),earned:t(x.earned_sim),releasable:t(x.releasable_at_sim),holdback:x.holdback_days,reserveBps:x.reserve_bps,version:x.config_version,event:x.state}));
}
const journals=async(db:Database,keys:string[])=>new Map((await db.query('SELECT idempotency_key AS k,payload_hash AS h,basis_bps FROM demo_journal_entries WHERE idempotency_key=ANY($1::text[])',[keys])).rows.map(r=>[r.k as string,{hash:r.h as string,basis:r.basis_bps as number|null}]));

test('a sale posts E1, E2, a held lot and its EARNED event per credit; payees appear with a sandbox token; balances reconcile',async()=>{
  const {db,scenario}=await setup();
  const before=Date.now(),orderId=await sell(db,4);
  const rows=await earnings(db,orderId);
  assert.equal(rows.length,4);
  const posted=await journals(db,rows.flatMap(r=>[`EARN:${r.id}`,`FUND:${r.id}`]));
  for(const r of rows){
    const j=earningJournals({ledgerEntryId:r.id,payeeGroupId:r.payee,grossPaise:r.g,commissionPaise:r.c,netPaise:r.n,reserveBps:2000});
    assert.equal(posted.get(j.earned.key)?.hash,j.earned.payloadHash,'EARN journal as the domain builds it');
    assert.deepEqual(posted.get(j.funded!.key),{hash:j.funded!.payloadHash,basis:2000},'FUND journal with its basis');
    assert.equal(r.event,'EARNED');assert.equal(r.holdback,7);assert.equal(r.reserveBps,2000);assert.equal(r.version,0,'built-in defaults');
    assert.ok(r.earned!>=before-60_000&&r.earned!<=Date.now()+60_000,'earned in simulated time = real time while the clock is at 0');
    assert.equal(r.releasable!-r.earned!,7*DAY,'a first-time payee is held for the holdback');
  }
  const payees=[...new Set(rows.map(r=>r.payee))].sort();
  const p=await db.query('SELECT p.payee_group_id::text AS id,p.account_token,s.reverify_required FROM demo_payees p JOIN demo_payee_state s USING (scenario_id,payee_group_id) ORDER BY 1');
  assert.deepEqual(p.rows,payees.map(id=>({id,account_token:sandboxToken(id),reverify_required:false})));
  for(const payee of payees)assert.equal(await balance(db,scenario,'payee_payable',payee),rows.filter(r=>r.payee===payee).reduce((s,r)=>s+r.n,0n));
  const reserve=rows.reduce((s,r)=>s+commissionPaise(r.c,2000),0n);
  assert.equal(await balance(db,scenario,'reversal_reserve'),reserve);
  assert.equal(await balance(db,scenario,'commission_revenue'),rows.reduce((s,r)=>s+r.c,0n)-reserve);
  assert.equal(-(await balance(db,scenario,'buyer_funds_clearing')),PRICE*4n);
  assert.deepEqual(await assertMarketInvariants(db,{lapseGraceSeconds:3600}),[]);
});

test('holdback: none once the payee has a SETTLED payout; a held lot stays held; an existing payee keeps its token',async()=>{
  const {db,scenario}=await setup({groups:1,perGroup:60});
  const first=(await earnings(db,await sell(db,1)))[0];
  assert.equal(first.releasable!-first.earned!,7*DAY);
  const payee=first.payee;
  await db.query(`UPDATE demo_payees SET account_token=$2 WHERE payee_group_id=$1`,[payee,sandboxToken(payee,'05')]);
  const b=await addBatch(db,scenario),po=await addPayout(db,scenario,b,payee,500n);
  await db.query(`UPDATE demo_payouts SET state='IN_SETTLEMENT' WHERE id=$1`,[po]);
  await db.query(`UPDATE demo_payouts SET state='SETTLED' WHERE id=$1`,[po]);
  const second=(await earnings(db,await sell(db,1)))[0];
  assert.equal(second.payee,payee);assert.equal(second.releasable,second.earned,'paid before: releasable at once');
  const held=await db.query('SELECT extract(epoch FROM releasable_at_sim-earned_sim)::int AS s FROM demo_earning_lots WHERE ledger_entry_id=$1',[first.id]);
  assert.equal(held.rows[0].s,7*86400,'the first lot is still held');
  assert.equal((await db.query('SELECT account_token FROM demo_payees WHERE payee_group_id=$1',[payee])).rows[0].account_token,sandboxToken(payee,'05'),'a sale never resets the token');
});

test('the demo clock: compare-and-set, forward only, bounded; sales after a jump are earned and held in simulated time',async()=>{
  const {db,scenario}=await setup();
  assert.deepEqual((await db.transaction(tx=>simNow(tx,scenario))).offsetSeconds,0);
  const moved=await advanceClock(db,scenario,{expectedOffsetSeconds:0,advanceSeconds:30*86400});
  assert.equal(moved.offsetSeconds,30*86400);
  assert.ok(Math.abs(moved.sim.getTime()-moved.real.getTime()-30*DAY)<1000);
  await assert.rejects(advanceClock(db,scenario,{expectedOffsetSeconds:0,advanceSeconds:60}),code('CLOCK_CONFLICT'),'a stale double-click does not advance twice');
  for(const bad of [0,-60,30*86400+1,1.5])await assert.rejects(advanceClock(db,scenario,{expectedOffsetSeconds:30*86400,advanceSeconds:bad}),code('VALIDATION_FAILED'),String(bad));
  let offset=30*86400;
  while(offset+30*86400<=31_536_000){await advanceClock(db,scenario,{expectedOffsetSeconds:offset,advanceSeconds:30*86400});offset+=30*86400;}
  await assert.rejects(advanceClock(db,scenario,{expectedOffsetSeconds:offset,advanceSeconds:30*86400}),code('CLOCK_LIMIT'),'at most a year ahead');
  await assert.rejects(advanceClock(db,'no-such-scenario',{expectedOffsetSeconds:0,advanceSeconds:60}),code('NOT_FOUND'));
  const lot=(await earnings(db,await sell(db,1)))[0];
  assert.ok(Math.abs(lot.earned!-Date.now()-offset*1000)<60_000,'earned in simulated time');
  assert.equal(lot.releasable!-lot.earned!,7*DAY,'held for 7 simulated days after the jump');
});

test('configuration is read per scenario at simulated time; lots snapshot version, reserve and holdback',async()=>{
  const {db,scenario}=await setup();
  const insert=(v:number,o:{reserve:number;holdback:number;from:string})=>db.query(`INSERT INTO demo_ledger_config(scenario_id,version,holdback_days,reserve_bps,min_payout_paise,payout_limit_paise,backoff_base_seconds,idempotency_window_seconds,effective_from,created_by) VALUES ($1,$2,$3,$4,10000,5000000,5,86400,${o.from},'presenter')`,[scenario,v,o.holdback,o.reserve]);
  await insert(1,{reserve:0,holdback:0,from:`now()-interval '1 hour'`});
  await insert(2,{reserve:5000,holdback:3,from:`now()+interval '2 days'`});
  const v1=(await earnings(db,await sell(db,2)));
  for(const r of v1){assert.equal(r.version,1);assert.equal(r.reserveBps,0);assert.equal(r.holdback,0);assert.equal(r.releasable,r.earned);}
  assert.equal((await journals(db,v1.map(r=>`FUND:${r.id}`))).size,0,'no reserve journal at 0 bps');
  await advanceClock(db,scenario,{expectedOffsetSeconds:0,advanceSeconds:3*86400});
  const v2=(await earnings(db,await sell(db,1)))[0];
  assert.equal(v2.version,2);assert.equal(v2.reserveBps,5000);assert.equal(v2.releasable!-v2.earned!,3*DAY,'version 2 is effective in simulated time');
  assert.deepEqual(DEFAULT_LEDGER_CONFIG,{version:0,holdbackDays:7,reserveBps:2000,minPayoutPaise:10000n,payoutLimitPaise:5000000n,backoffBaseSeconds:5,idempotencyWindowSeconds:86400});
});

test('0% and 100% commission sales succeed: zero lines are skipped and a zero-net sale has no lot',async()=>{
  const {db,scenario}=await setup();
  const free=await earnings(db,await sell(db,1,{...DEFAULT_MARKET,commissionBps:0}));
  assert.equal(free[0].c,0n);assert.equal(free[0].event,'EARNED');
  const all=await earnings(db,await sell(db,1,{...DEFAULT_MARKET,commissionBps:10000}));
  assert.equal(all[0].n,0n);assert.equal(all[0].event,null,'no lot');
  const lines=await db.query(`SELECT j.idempotency_key AS k,count(*)::int AS n FROM demo_journal_entries j JOIN demo_journal_lines l ON l.journal_id=j.id WHERE j.idempotency_key=ANY($1::text[]) GROUP BY 1 ORDER BY 1`,
    [[`EARN:${free[0].id}`,`FUND:${free[0].id}`,`EARN:${all[0].id}`,`FUND:${all[0].id}`]]);
  assert.deepEqual(lines.rows,[{k:`EARN:${all[0].id}`,n:2},{k:`EARN:${free[0].id}`,n:2},{k:`FUND:${all[0].id}`,n:2}].sort((a,b)=>a.k<b.k?-1:1));
  assert.equal(await balance(db,scenario,'reversal_reserve'),commissionPaise(PRICE,2000));
});

test('0009 parity: a ledger row commits only with its matching EARN journal, lot, EARNED event and reserve journal',async()=>{
  const {db,m,scenario}=await setup({groups:2,perGroup:10});const g=m.groups[0];
  const sale=(earn?:(tx:Database,rows:LedgerRow[])=>Promise<unknown>)=>sellDirect(db,{scenario,group:g,commissions:[5002n],earnings:earn});
  const entries=(rows:LedgerRow[])=>rows.map(r=>({ledgerEntryId:r.id,payeeGroupId:g.capture,grossPaise:BigInt(r.gross_paise),commissionPaise:BigInt(r.commission_paise),netPaise:BigInt(r.net_paise)}));
  await assert.rejects(sale(),/EARN/,'no earnings at all');
  // Hand-written earnings, each missing or bending one piece.
  const write=(o:{tamper?:'earn'|'fund'|'nolot'|'noevent'|'nofund'})=>async(tx:Database,rows:LedgerRow[])=>{
    const r=rows[0],e=entries(rows)[0];
    await tx.query(`INSERT INTO demo_payees(scenario_id,payee_group_id,account_token,verified_at) VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING`,[scenario,g.capture,sandboxToken(g.capture)]);
    await tx.query(`INSERT INTO demo_payee_state(scenario_id,payee_group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,[scenario,g.capture]);
    const j=earningJournals({...e,reserveBps:2000});
    const earn=o.tamper==='earn'?earningJournals({...e,commissionPaise:e.commissionPaise+1n,netPaise:e.netPaise-1n,reserveBps:2000}).earned:j.earned;
    await writeJournal(tx,scenario,earn,{ledgerEntryId:r.id});
    if(o.tamper!=='nofund'){const f=o.tamper==='fund'?earningJournals({...e,reserveBps:2500}).funded!:j.funded!;await writeJournal(tx,scenario,f,{ledgerEntryId:r.id,basisBps:2000});}
    if(o.tamper!=='nolot')await tx.query(`INSERT INTO demo_earning_lots(ledger_entry_id,scenario_id,payee_group_id,net_paise,earned_sim,releasable_at_sim,holdback_days,reserve_bps,config_version) VALUES ($1,$2,$3,$4,now(),now(),7,2000,0)`,[r.id,scenario,g.capture,r.net_paise]);
    if(o.tamper!=='nolot'&&o.tamper!=='noevent')await tx.query(`INSERT INTO demo_lot_events(ledger_entry_id,seq,scenario_id,state,at_sim) VALUES ($1,1,$2,'EARNED',now())`,[r.id,scenario]);
  };
  await assert.rejects(sale(write({tamper:'earn'})),/EARN/,'EARN amounts differ from the ledger row');
  await assert.rejects(sale(write({tamper:'fund'})),/reserve|FUND/,'reserve share differs from half_even(c x basis)');
  await assert.rejects(sale(write({tamper:'nofund'})),/reserve|FUND/,'a positive reserve share must be funded');
  await assert.rejects(sale(write({tamper:'nolot'})),/lot/,'positive net needs a lot');
  await assert.rejects(sale(write({tamper:'noevent'})),/event/,'a lot needs its EARNED event');
  await sale(write({}));
  await sale((tx,rows)=>postEarnings(tx,scenario,entries(rows)));
  // A ledger row added to an order that is already fulfilled breaks the order's totals, earnings or not.
  const done=(await db.query(`SELECT order_id FROM demo_ledger_entries ORDER BY id DESC LIMIT 1`)).rows[0].order_id;
  const spare=(await db.query(`SELECT id FROM demo_credits WHERE id=ANY($1::text[]) AND state='AVAILABLE' LIMIT 1`,[g.creditIds])).rows[0].id;
  await assert.rejects(db.transaction(async tx=>{
    const id=(await tx.query(`INSERT INTO demo_ledger_entries(order_id,scenario_id,credit_id,payee_group_id,gross_paise,commission_paise,net_paise) VALUES ($1,$2,$3,$4,$5,5002,$6) RETURNING id::text AS id`,[done,scenario,spare,g.capture,String(PRICE),String(PRICE-5002n)])).rows[0].id;
    await postEarnings(tx,scenario,[{ledgerEntryId:id,payeeGroupId:g.capture,grossPaise:PRICE,commissionPaise:5002n,netPaise:PRICE-5002n}]);
  }),/order/);
});

test('a journal whose lines do not match its payload hash fails at commit',async()=>{
  const {db,scenario}=await setup();
  const orderId=await sell(db,1);const payee=(await earnings(db,orderId))[0].payee;
  const b=await addBatch(db,scenario),po=await addPayout(db,scenario,b,payee,500n);
  const pb=payoutBatched(po,payee,500n);
  await assert.rejects(db.transaction(tx=>writeJournal(tx,scenario,{...pb,payloadHash:payoutBatched(po,payee,501n).payloadHash},{payoutId:po})),/hash/);
  await db.transaction(tx=>writeJournal(tx,scenario,pb,{payoutId:po}));
});

test('journals are idempotent by key: the same content is a no-op, different content under the same key is refused',async()=>{
  const {db,scenario}=await setup();
  const r=(await earnings(db,await sell(db,1)))[0];
  const j=earningJournals({ledgerEntryId:r.id,payeeGroupId:r.payee,grossPaise:r.g,commissionPaise:r.c,netPaise:r.n,reserveBps:2000});
  const lines=async()=>(await db.query('SELECT count(*)::int AS n FROM demo_journal_lines')).rows[0].n as number;
  const before=await lines();
  assert.deepEqual(await db.transaction(tx=>postJournals(tx,scenario,[{spec:j.earned,ledgerEntryId:r.id},{spec:j.funded!,ledgerEntryId:r.id}])),{posted:0,replayed:2});
  assert.equal(await lines(),before);
  const other=earningJournals({ledgerEntryId:r.id,payeeGroupId:r.payee,grossPaise:r.g,commissionPaise:r.c+1n,netPaise:r.n-1n,reserveBps:2000});
  await assert.rejects(db.transaction(tx=>postJournals(tx,scenario,[{spec:other.earned,ledgerEntryId:r.id}])),code('JOURNAL_KEY_CONFLICT'));
  // postEarnings itself is a no-op when replayed for the same ledger rows.
  await db.transaction(tx=>postEarnings(tx,scenario,[{ledgerEntryId:r.id,payeeGroupId:r.payee,grossPaise:r.g,commissionPaise:r.c,netPaise:r.n}]));
  assert.equal(await lines(),before);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM demo_lot_events WHERE ledger_entry_id=$1',[r.id])).rows[0].n,1);
});
