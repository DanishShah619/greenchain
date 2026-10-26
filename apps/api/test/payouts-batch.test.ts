import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Database} from '../src/kernel/database.js';
import {DEFAULT_MARKET} from '../src/modules/market/application/orders.js';
import {advanceClock} from '../src/modules/payouts/application/clock.js';
import {batchPayee,createPresenterBatch,ensureScheduledBatch,runBatch,runDueBatches} from '../src/modules/payouts/application/batch.js';
import {seedMarket} from './support/market.js';
import {migratedPglite} from './support/pglite.js';
import {balance,sellViaWebhook,setLedgerConfig} from './support/payouts.js';
// The batcher (docs/23 §6.2, P8): one payout per payee per batch from releasable lots, rollover below the minimum, the limit
// taken oldest first, re-verification skips, presenter runs replayed by request id, interrupted batches resumed.
const BUYERS=Array.from({length:12},(_,i)=>`buyer-${i+1}`);
async function setup(o:{groups?:number;perGroup?:number;holdbackDays?:number;minPaise?:bigint;limitPaise?:bigint}={}){
  const {db}=await migratedPglite();
  const m=await seedMarket(db,{groups:o.groups??4,perGroup:o.perGroup??20,buyers:BUYERS});
  await setLedgerConfig(db,m.scenario,1,{holdbackDays:o.holdbackDays??0,minPaise:o.minPaise,limitPaise:o.limitPaise});
  let next=0;
  const sell=(quantity=1,bps=DEFAULT_MARKET.commissionBps)=>sellViaWebhook(db,{buyerId:BUYERS[next++%BUYERS.length],quantity,market:{...DEFAULT_MARKET,commissionBps:bps}});
  return {db,m,scenario:m.scenario,sell};
}
/** Latest event of every lot, with its payout. */
const lotStates=async(db:Database)=>(await db.query(`SELECT DISTINCT ON (ledger_entry_id) ledger_entry_id::text AS id,state,payout_id::text AS payout FROM demo_lot_events ORDER BY ledger_entry_id,seq DESC`)).rows as {id:string;state:string;payout:string|null}[];
const payouts=async(db:Database)=>(await db.query(`SELECT p.id::text AS id,p.batch_id::text AS batch,p.payee_group_id::text AS payee,p.account_token AS token,p.gross_paise::text AS gross,p.amount_paise::text AS amount,p.state,p.flags,
  (SELECT coalesce(sum(l.net_paise),0)::text FROM demo_payout_items i JOIN demo_earning_lots l ON l.ledger_entry_id=i.ledger_entry_id WHERE i.payout_id=p.id AND i.active) AS items,
  (SELECT total_paise::text FROM demo_journal_entries WHERE idempotency_key='PB:'||p.id) AS e12
  FROM demo_payouts p ORDER BY p.created_at,p.payee_group_id`)).rows as {id:string;batch:string;payee:string;token:string;gross:string;amount:string;state:string;flags:string[];items:string;e12:string|null}[];
const netByPayee=async(db:Database)=>new Map((await db.query(`SELECT payee_group_id::text AS p,sum(net_paise)::text AS n FROM demo_ledger_entries GROUP BY 1`)).rows.map(r=>[r.p as string,BigInt(r.n)]));

test('a scheduled batch pays each releasable payee once: items, E12 and IN_BATCH events; payable moves to clearing',async()=>{
  const {db,scenario,sell}=await setup();
  for(let i=0;i<4;i++)await sell(2);
  const [summary]=await runDueBatches(db,scenario);
  assert.equal(summary.runSeq,0);assert.equal(summary.status,'COMPLETED');assert.equal(summary.failedPayees,0);
  const ps=await payouts(db),nets=await netByPayee(db);
  assert.equal(ps.length,nets.size,'one payout per payee');assert.equal(summary.payouts,ps.length);
  const tokens=new Map((await db.query('SELECT payee_group_id::text AS p,account_token AS t FROM demo_payees')).rows.map(r=>[r.p,r.t]));
  for(const p of ps){
    assert.equal(p.state,'PENDING');assert.equal(p.token,tokens.get(p.payee),'token snapshot');
    assert.equal(p.gross,String(nets.get(p.payee)));assert.equal(p.amount,p.gross);assert.equal(p.items,p.gross,'gross = sum of active items');assert.equal(p.e12,p.gross,'E12 posted for the amount');
    assert.equal(await balance(db,scenario,'payee_payable',p.payee),0n,'nothing left payable');
  }
  assert.equal(await balance(db,scenario,'payout_clearing'),[...nets.values()].reduce((a,b)=>a+b,0n));
  const states=await lotStates(db);
  assert.ok(states.length===8&&states.every(s=>s.state==='IN_BATCH'&&ps.some(p=>p.id===s.payout)));
  // Same simulated day: the scheduled run exists and is complete, so nothing new happens.
  assert.deepEqual(await runDueBatches(db,scenario),[]);
  assert.equal((await payouts(db)).length,ps.length);
});

test('held lots wait for their holdback; each simulated day gets its own scheduled batch',async()=>{
  const {db,scenario,sell}=await setup({holdbackDays:7});
  await sell(2);
  const [day1]=await runDueBatches(db,scenario);
  assert.equal(day1.payouts,0,'a first-time payee is held');assert.equal(day1.status,'COMPLETED');
  await advanceClock(db,scenario,{expectedOffsetSeconds:0,advanceSeconds:6*86400});
  assert.equal((await runDueBatches(db,scenario))[0].payouts,0,'still held after 6 simulated days');
  await advanceClock(db,scenario,{expectedOffsetSeconds:6*86400,advanceSeconds:86400});
  const [day8]=await runDueBatches(db,scenario);
  assert.ok(day8.payouts>=1,'released on day 8');assert.notEqual(day8.runDate,day1.runDate);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM demo_payout_batches WHERE run_seq=0')).rows[0].n,3);
});

test('released lots of a payee go while its lots still held stay out',async()=>{
  const {db,scenario,sell}=await setup({groups:1,perGroup:40,holdbackDays:7});
  await sell(1);
  await advanceClock(db,scenario,{expectedOffsetSeconds:0,advanceSeconds:7*86400});
  await sell(1);   // same payee, never paid: held for 7 days from now (simulated)
  const [run]=await runDueBatches(db,scenario);
  assert.equal(run.payouts,1);
  const [p]=await payouts(db);
  assert.equal(p.gross,'95028','only the released lot');
  const states=(await lotStates(db)).map(s=>s.state).sort();
  assert.deepEqual(states,['EARNED','IN_BATCH']);
});

test('below the minimum rolls over; the limit takes lots oldest first; a lot above the limit is skipped and flagged',async()=>{
  const {db,scenario,sell}=await setup({groups:1,perGroup:40,minPaise:200000n});
  await sell(1);
  const [first]=await runDueBatches(db,scenario);
  assert.equal(first.payouts,0);assert.equal(first.rolledOver,1,'95,028 paise is under the 200,000 minimum');
  await setLedgerConfig(db,scenario,2,{holdbackDays:0,minPaise:10000n,limitPaise:99000n});
  await sell(1,0);await sell(1);   // net 100,030 (above the limit), then 95,028
  const run=async()=>{const b=await createPresenterBatch(db,scenario,{requestId:randomUUID(),actorId:'presenter'});return runBatch(db,b.batchId);};
  const second=await run();
  assert.equal(second.payouts,1);assert.equal(second.oversizedLots,1);
  const [p]=(await payouts(db)).filter(x=>x.batch===second.batchId);
  assert.equal(p.gross,'95028','only the oldest lot fits under 99,000');assert.deepEqual(p.flags,['OVERSIZED_LOT_SKIPPED']);
  const oldest=(await db.query(`SELECT min(ledger_entry_id)::text AS id FROM demo_earning_lots`)).rows[0].id;
  assert.deepEqual((await db.query('SELECT ledger_entry_id::text AS id FROM demo_payout_items WHERE payout_id=$1',[p.id])).rows.map(r=>r.id),[oldest],'the oldest lot, not the newest of equal size');
  const third=await run();
  assert.equal(third.payouts,1,'the next lot goes in the next run');assert.equal(third.oversizedLots,1,'the oversized lot is still skipped');
  const states=await lotStates(db);
  assert.equal(states.filter(s=>s.state==='EARNED').length,1,'the oversized lot stays payable');
  assert.equal(await balance(db,scenario,'payee_payable',(await payouts(db))[0].payee),100030n);
});

test('a payee awaiting re-verification is skipped and stays payable',async()=>{
  const {db,m,scenario,sell}=await setup({groups:2,perGroup:20});
  await sell(2);await sell(2);   // two orders: one of 4 would exceed a buyer's supply share and become a shortfall offer
  const payees=[...(await netByPayee(db)).keys()].sort();
  assert.ok(payees.length>=2,'needs a payee to skip and one to pay');
  await db.query('UPDATE demo_payee_state SET reverify_required=true WHERE payee_group_id=$1',[payees[0]]);
  const [s]=await runDueBatches(db,scenario);
  assert.equal(s.skippedReverify,1);assert.equal(s.payouts,payees.length-1);
  assert.ok(!(await payouts(db)).some(p=>p.payee===payees[0]));
  assert.equal(await balance(db,scenario,'payee_payable',payees[0]),(await netByPayee(db)).get(payees[0]));
  assert.ok(m.groups.length===2);
});

test('presenter runs: run_seq counts up per simulated day; the same request id replays the same batch',async()=>{
  const {db,scenario,sell}=await setup();
  await sell(2);
  const request=randomUUID();
  const a=await createPresenterBatch(db,scenario,{requestId:request,actorId:'presenter'});
  assert.equal(a.replayed,false);assert.equal(a.runSeq,1);
  const ra=await runBatch(db,a.batchId);assert.ok(ra.payouts>=1);
  const again=await createPresenterBatch(db,scenario,{requestId:request,actorId:'presenter'});
  assert.deepEqual({id:again.batchId,replayed:again.replayed},{id:a.batchId,replayed:true});
  const rerun=await runBatch(db,again.batchId);
  assert.equal(rerun.payouts,0,'running a completed batch again pays nothing');assert.equal(rerun.status,'COMPLETED');
  const b=await createPresenterBatch(db,scenario,{requestId:randomUUID(),actorId:'presenter'});
  assert.equal(b.runSeq,2);
  assert.equal((await runBatch(db,b.batchId)).payouts,0,'nothing new to pay');
  await sell(1);
  const c=await createPresenterBatch(db,scenario,{requestId:randomUUID(),actorId:'presenter'});
  assert.equal(c.runSeq,3);assert.equal((await runBatch(db,c.batchId)).payouts,1,'only the new sale');
  await assert.rejects(createPresenterBatch(db,scenario,{requestId:'not-a-uuid',actorId:'presenter'}),(e:any)=>e.code==='VALIDATION_FAILED');
});

test('an interrupted batch is resumed by the worker, and a payee already paid in it is not paid twice',async()=>{
  const {db,scenario,sell}=await setup();
  await sell(3);
  const created=await ensureScheduledBatch(db,scenario);
  assert.equal(created.created,true);
  const payees=[...(await netByPayee(db)).keys()].sort();
  // The process "crashed" after paying the first payee: the batch is still RUNNING.
  assert.equal(await batchPayee(db,created.batchId,payees[0]),'PAID');
  assert.equal(await batchPayee(db,created.batchId,payees[0]),'ALREADY_BATCHED');
  assert.equal((await ensureScheduledBatch(db,scenario)).created,false);
  const [resumed]=await runDueBatches(db,scenario);
  assert.equal(resumed.batchId,created.batchId);assert.equal(resumed.status,'COMPLETED');
  assert.equal(resumed.payouts,payees.length-1,'the rest were paid on resume');
  assert.equal((await payouts(db)).length,payees.length);
  // Conservation per payee (docs/23 invariant 7): every net is payable or in a live payout.
  for(const [payee,net] of await netByPayee(db)){
    const inPayouts=(await payouts(db)).filter(p=>p.payee===payee).reduce((s,p)=>s+BigInt(p.amount),0n);
    assert.equal((await balance(db,scenario,'payee_payable',payee))+inPayouts,net);
  }
});
