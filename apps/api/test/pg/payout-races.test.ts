import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,race,testDatabaseUrl} from '../support/pg.js';
import {seedMarket} from '../support/market.js';
import {sellViaWebhook,setLedgerConfig} from '../support/payouts.js';
import {createPresenterBatch,runBatch,runDueBatches,type BatchSummary} from '../../src/modules/payouts/application/batch.js';
import type {Database} from '../../src/kernel/database.js';
import pg from 'pg';
import {runSettlementCycle,sendPayout} from '../../src/modules/payouts/application/settlement.js';
import {SandboxRail} from '../../src/modules/payouts/infrastructure/sandbox-rail.js';
import type {PayoutRail} from '../../src/modules/payouts/domain/rail.js';
// Races of the payout batcher on real PostgreSQL (docs/23 §7): several connections, real row locks.
const opts={skip:testDatabaseUrl?false:'TEST_DATABASE_URL is not set (the guard test fails loudly in npm run test:pg)'};
const BUYERS=Array.from({length:40},(_,i)=>`buyer-${i+1}`);
const ok=<T>(results:PromiseSettledResult<T>[])=>results.map(r=>{assert.equal(r.status,'fulfilled',String((r as PromiseRejectedResult).reason));return (r as PromiseFulfilledResult<T>).value;});
/** Every lot of the scenario: how many IN_BATCH events it has, its latest state, and in how many live items it sits. */
async function lotAccounting(db:Database){
  return (await db.query(`SELECT l.ledger_entry_id::text AS id,
      (SELECT count(*)::int FROM demo_lot_events e WHERE e.ledger_entry_id=l.ledger_entry_id AND e.state='IN_BATCH') AS batched,
      (SELECT state FROM demo_lot_events e WHERE e.ledger_entry_id=l.ledger_entry_id ORDER BY seq DESC LIMIT 1) AS state,
      (SELECT count(*)::int FROM demo_payout_items i WHERE i.ledger_entry_id=l.ledger_entry_id AND i.active) AS items
    FROM demo_earning_lots l`)).rows as {id:string;batched:number;state:string;items:number}[];
}
async function conserved(db:Database){
  const r=(await db.query(`SELECT (SELECT coalesce(sum(net_paise),0) FROM demo_earning_lots)::text AS lots,
    (SELECT coalesce(sum(gross_paise),0) FROM demo_payouts)::text AS payouts,
    (SELECT coalesce(sum(CASE side WHEN 'CR' THEN amount_paise ELSE -amount_paise END),0) FROM demo_journal_lines WHERE account='payee_payable')::text AS payable,
    (SELECT count(*)::int FROM demo_payouts p WHERE gross_paise<>(SELECT sum(l.net_paise) FROM demo_payout_items i JOIN demo_earning_lots l USING (ledger_entry_id) WHERE i.payout_id=p.id AND i.active)) AS bad`)).rows[0];
  assert.equal(r.bad,0,'every payout equals the sum of its items');
  assert.equal(BigInt(r.payable)+BigInt(r.payouts),BigInt(r.lots),'every net is payable or in a payout');
}
async function market(groups:number,perGroup:number){
  const t=await createTestDatabase();
  const m=await seedMarket(t.db,{groups,perGroup,buyers:BUYERS});
  await setLedgerConfig(t.db,m.scenario,1,{holdbackDays:0});
  return {t,scenario:m.scenario};
}

test('the scheduled run and two presenter runs racing over the same payees: each lot is batched once, nothing fails',opts,async()=>{
  const {t,scenario}=await market(12,6);
  try{
    for(let i=0;i<12;i++)await sellViaWebhook(t.db,{buyerId:BUYERS[i],quantity:2});
    const runs=ok(await race(3,async i=>{
      const db=t.connect();
      if(i===0)return runDueBatches(db,scenario);
      const b=await createPresenterBatch(db,scenario,{requestId:randomUUID(),actorId:'presenter'});
      return [await runBatch(db,b.batchId)];
    })).flat() as BatchSummary[];
    assert.ok(runs.every(s=>s.failedPayees===0&&s.status==='COMPLETED'),JSON.stringify(runs));
    const lots=await lotAccounting(t.db);
    assert.equal(lots.length,24);
    assert.ok(lots.every(l=>l.batched===1&&l.state==='IN_BATCH'&&l.items===1),'each lot in exactly one payout');
    assert.equal(runs.reduce((s,r)=>s+r.payouts,0),(await t.db.query('SELECT count(*)::int AS n FROM demo_payouts')).rows[0].n);
    await conserved(t.db);
  }finally{await t.close();}
});

test('batches racing sales for the same payee: each lot lands in this batch or the next, never both or neither',opts,async()=>{
  const {t,scenario}=await market(1,60);
  try{
    for(let i=0;i<4;i++)await sellViaWebhook(t.db,{buyerId:BUYERS[i]});
    ok(await race(10,async i=>{
      const db=t.connect();
      if(i%2===0)return sellViaWebhook(db,{buyerId:BUYERS[10+i]});
      const b=await createPresenterBatch(db,scenario,{requestId:randomUUID(),actorId:'presenter'});
      const s=await runBatch(db,b.batchId);assert.equal(s.failedPayees,0);return s;
    }));
    const b=await createPresenterBatch(t.db,scenario,{requestId:randomUUID(),actorId:'presenter'});await runBatch(t.db,b.batchId);
    const lots=await lotAccounting(t.db);
    assert.equal(lots.length,9);
    assert.ok(lots.every(l=>l.batched===1&&l.items===1),JSON.stringify(lots));
    await conserved(t.db);
  }finally{await t.close();}
});

test('concurrent presenter requests: one batch per request id, run numbers allocated without gaps or collisions',opts,async()=>{
  const {t,scenario}=await market(2,4);
  try{
    const request=randomUUID();
    const same=ok(await race(8,()=>createPresenterBatch(t.connect(),scenario,{requestId:request,actorId:'presenter'})));
    assert.equal(new Set(same.map(s=>s.batchId)).size,1);assert.equal(same.filter(s=>!s.replayed).length,1);
    const distinct=ok(await race(8,()=>createPresenterBatch(t.connect(),scenario,{requestId:randomUUID(),actorId:'presenter'})));
    assert.deepEqual(distinct.map(s=>s.runSeq).sort((a,b)=>a-b),[2,3,4,5,6,7,8,9]);
  }finally{await t.close();}
});

const sendCalls=async(db:Database,id?:string)=>(await db.query(`SELECT count(*)::int AS n FROM demo_sandbox_calls WHERE op='send' AND ($1::uuid IS NULL OR payout_id=$1)`,[id??null])).rows[0].n as number;
const getCalls=async(db:Database)=>(await db.query(`SELECT count(*)::int AS n FROM demo_sandbox_calls WHERE op='get'`)).rows[0].n as number;

test('a sender stalled inside its rail call: resolvers wait for its real-time lease, so the payout is sent once',opts,async()=>{
  const {t,scenario}=await market(1,10);
  try{
    await sellViaWebhook(t.db,{buyerId:BUYERS[0]});await runDueBatches(t.db,scenario);
    const id=(await t.db.query('SELECT id::text AS id FROM demo_payouts')).rows[0].id as string;
    const sandbox=new SandboxRail(t.db);
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
    const stalled:PayoutRail={...sandbox,getByKey:c=>sandbox.getByKey(c),voidKey:c=>sandbox.voidKey(c),send:async r=>{await gate;return sandbox.send(r);}};
    const sender=sendPayout(t.connect(),id,{rail:stalled,deadlineMs:60_000,leaseSeconds:30});
    for(let i=0;i<5;i++){
      await new Promise(r=>setTimeout(r,100));
      await runSettlementCycle(t.connect(),scenario,{rail:sandbox});
    }
    assert.equal(await getCalls(t.db),0,'no resolver touched the payout while the lease was live');
    release();
    assert.equal(await sender,'SENT');
    assert.equal(await sendCalls(t.db,id),1);
  }finally{await t.close();}
});

test('six workers sending at once: every payout is sent exactly once and no worker fails',opts,async()=>{
  const {t,scenario}=await market(20,4);
  try{
    for(let i=0;i<20;i++)await sellViaWebhook(t.db,{buyerId:BUYERS[i],quantity:2});
    await runDueBatches(t.db,scenario);
    const n=(await t.db.query('SELECT count(*)::int AS n FROM demo_payouts')).rows[0].n as number;
    assert.ok(n>=10);
    const results=ok(await race(6,()=>runSettlementCycle(t.connect(),scenario,{rail:new SandboxRail(t.db),limit:100})));
    assert.ok(results.every(r=>r.failed===0),JSON.stringify(results));
    assert.equal(results.reduce((s,r)=>s+r.sent,0),n);
    const per=(await t.db.query(`SELECT p.id,(SELECT count(*)::int FROM demo_sandbox_calls c WHERE c.payout_id=p.id AND c.op='send') AS sends FROM demo_payouts p`)).rows;
    assert.ok(per.every(r=>r.sends===1),JSON.stringify(per.filter(r=>r.sends!==1)));
    assert.equal((await t.db.query(`SELECT count(*)::int AS n FROM demo_payouts WHERE state='SENT'`)).rows[0].n,n);
  }finally{await t.close();}
});

test('a sale racing the settlement of the first payout to its payee: the holdback decision waits for the payee lock',opts,async()=>{
  const {t,scenario}=await market(1,10);
  try{
    await sellViaWebhook(t.db,{buyerId:BUYERS[0]});await runDueBatches(t.db,scenario);
    await runSettlementCycle(t.db,scenario,{rail:new SandboxRail(t.db)});
    const payout=(await t.db.query(`SELECT id::text AS id,payee_group_id::text AS payee FROM demo_payouts`)).rows[0];
    await setLedgerConfig(t.db,scenario,2,{holdbackDays:7});
    // A settlement in progress: payee lock held, payout SETTLED, not yet committed.
    const settle=new pg.Client({connectionString:t.url});await settle.connect();
    try{
      await settle.query('BEGIN');
      await settle.query('SELECT 1 FROM demo_payee_state WHERE scenario_id=$1 AND payee_group_id=$2 FOR UPDATE',[scenario,payout.payee]);
      await settle.query(`UPDATE demo_payouts SET state='SETTLED' WHERE id=$1`,[payout.id]);
      const sale=sellViaWebhook(t.connect(),{buyerId:BUYERS[1]});
      await new Promise(r=>setTimeout(r,1000));
      await settle.query('COMMIT');
      await sale;
    }finally{await settle.end();}
    const lot=(await t.db.query(`SELECT extract(epoch FROM releasable_at_sim-earned_sim)::int AS held FROM demo_earning_lots ORDER BY ledger_entry_id DESC LIMIT 1`)).rows[0];
    assert.equal(lot.held,0,'the sale committed after the first payout settled, so it is not held');
  }finally{await t.close();}
});
