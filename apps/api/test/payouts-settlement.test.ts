import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from '../src/kernel/database.js';
import {advanceClock,simNow} from '../src/modules/payouts/application/clock.js';
import {createPresenterBatch,runBatch,runDueBatches} from '../src/modules/payouts/application/batch.js';
import {beginReconcile,beginSend,cancelPayout,finishReconcile,finishSend,runSettlementCycle} from '../src/modules/payouts/application/settlement.js';
import {sandboxToken,type SandboxSuffix} from '../src/modules/payouts/domain/config.js';
import {RailUnknownError,type PayoutRail} from '../src/modules/payouts/domain/rail.js';
import {SandboxRail} from '../src/modules/payouts/infrastructure/sandbox-rail.js';
import {seedMarket} from './support/market.js';
import {migratedPglite} from './support/pglite.js';
import {balance,sellViaWebhook,setLedgerConfig} from './support/payouts.js';
// Send, resolve, settle, return and cancel (docs/23 §6.3) against the sandbox rail, for every suffix, plus crash points.
const code=(c:string)=>(e:any)=>{assert.equal(e?.code,c);return true;};
async function setup(suffix:SandboxSuffix='00',sales=2){
  const {db}=await migratedPglite();
  const m=await seedMarket(db,{groups:1,perGroup:40,buyers:['buyer-1','buyer-2','buyer-3','buyer-4']});
  await setLedgerConfig(db,m.scenario,1,{holdbackDays:0});
  for(let i=0;i<sales;i++)await sellViaWebhook(db,{buyerId:`buyer-${i+1}`});
  const payee=(await db.query('SELECT payee_group_id::text AS p FROM demo_payees')).rows[0].p as string;
  if(suffix!=='00')await setSuffix(db,payee,suffix);
  const sandbox=new SandboxRail(db);
  const scenario=m.scenario;
  const advance=async(seconds:number)=>{const now=await db.transaction(tx=>simNow(tx,scenario));await advanceClock(db,scenario,{expectedOffsetSeconds:now.offsetSeconds,advanceSeconds:seconds});};
  /** One worker cycle (batches, then rail tick, sends, resolves, polls), then two simulated hours pass. */
  const cycle=async(rail:PayoutRail=sandbox)=>{await runDueBatches(db,scenario);const r=await runSettlementCycle(db,scenario,{rail,random:()=>0.5});await advance(7200);return r;};
  /** A presenter run: a batch now, whatever the simulated date (the scheduled run happens once per simulated IST day). */
  const presenterBatch=async()=>{const b=await createPresenterBatch(db,scenario,{requestId:crypto.randomUUID(),actorId:'presenter'});return runBatch(db,b.batchId);};
  return {db,scenario,payee,sandbox,advance,cycle,presenterBatch};
}
const setSuffix=(db:Database,payee:string,suffix:SandboxSuffix)=>db.query('UPDATE demo_payees SET account_token=$2 WHERE payee_group_id=$1',[payee,sandboxToken(payee,suffix)]);
type P={id:string;state:string;attempts:number;npc:boolean;flags:string[];amount:bigint;token:string};
const payouts=async(db:Database):Promise<P[]>=>(await db.query(`SELECT id::text AS id,state,attempts,non_payment_confirmed AS npc,flags,amount_paise::text AS amount,account_token AS token FROM demo_payouts ORDER BY created_at`)).rows.map(r=>({...r,amount:BigInt(r.amount)}) as P);
const one=async(db:Database)=>{const all=await payouts(db);assert.equal(all.length,1,'one payout');return all[0];};
const sends=async(db:Database,id:string)=>(await db.query(`SELECT count(*)::int AS n FROM demo_sandbox_calls WHERE payout_id=$1 AND op='send'`,[id])).rows[0].n as number;
const attempts=async(db:Database,id:string)=>(await db.query('SELECT class FROM demo_payout_attempts WHERE payout_id=$1 ORDER BY attempt_no',[id])).rows.map(r=>r.class as string|null);
const lots=async(db:Database)=>(await db.query(`SELECT DISTINCT ON (ledger_entry_id) state FROM demo_lot_events ORDER BY ledger_entry_id,seq DESC`)).rows.map(r=>r.state as string).sort();
/** Invariants 5 and 7 of docs/23 §8 and the rail oracle: books agree with payouts, and money moved exactly when it should. */
async function books(db:Database,scenario:string,sandbox:SandboxRail){
  const all=await payouts(db);
  const live=all.filter(p=>!['SETTLED','RETURNED','CANCELLED'].includes(p.state)).reduce((s,p)=>s+p.amount,0n);
  const kept=all.filter(p=>!['RETURNED','CANCELLED'].includes(p.state)).reduce((s,p)=>s+p.amount,0n);
  const net=BigInt((await db.query('SELECT coalesce(sum(net_paise),0)::text AS n FROM demo_ledger_entries')).rows[0].n);
  assert.equal(await balance(db,scenario,'payout_clearing'),live,'clearing holds exactly the live payouts');
  assert.equal(await balance(db,scenario,'payee_payable')+kept,net,'every net is payable or in a payout that was not reversed');
  for(const p of all){
    if(p.state==='SETTLED')assert.equal(await sandbox.processedTransfers(p.id),1,`settled payout ${p.id} paid once`);
    if(p.state==='CANCELLED')assert.equal(await sandbox.processedTransfers(p.id),0,`cancelled payout ${p.id} never paid`);
  }
}

test('00: sent, then settled on the next poll; E13 posted, lots PAID, one transfer',async()=>{
  const {db,scenario,sandbox,cycle}=await setup('00');
  await cycle();
  const p=await one(db);assert.equal(p.state,'SENT');assert.deepEqual(await attempts(db,p.id),['ACCEPTED']);
  await cycle();
  assert.equal((await one(db)).state,'SETTLED');
  assert.deepEqual(await lots(db),['PAID','PAID']);
  assert.equal(await balance(db,scenario,'bank_cash'),p.amount);
  assert.equal(await sends(db,p.id),1);
  await books(db,scenario,sandbox);
});

test('02: unknown outcomes are resolved by key and resent with the same key, at most 6 times; cancel waits for the window, then voids',async()=>{
  const {db,scenario,sandbox,cycle,advance,presenterBatch}=await setup('02');
  for(let i=0;i<8;i++)await cycle();
  const p=await one(db);
  assert.equal(p.state,'NEEDS_REVIEW');assert.equal(p.attempts,6);assert.equal(p.npc,false,'not found inside the window is not proof of non-payment');
  assert.equal(await sends(db,p.id),6,'never more than six sends');assert.deepEqual(await attempts(db,p.id),Array(6).fill('RESOLVED_ABSENT'));
  await assert.rejects(cancelPayout(db,p.id,{rail:sandbox}),code('PAYOUT_MAY_BE_PAID'));
  await advance(86400);
  assert.deepEqual(await cancelPayout(db,p.id,{rail:sandbox}),{state:'CANCELLED',replayed:false});
  assert.deepEqual(await cancelPayout(db,p.id,{rail:sandbox}),{state:'CANCELLED',replayed:true});
  assert.deepEqual(await lots(db),['RELEASED','RELEASED']);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM demo_journal_entries WHERE idempotency_key=$1`,[`PC:${p.id}`])).rows[0].n,1);
  await books(db,scenario,sandbox);
  assert.equal((await presenterBatch()).payouts,1);
  assert.equal((await payouts(db)).length,2,'released lots go out again in a later batch');
});

test('03: a timeout that was processed is found by key: no second transfer, then settled',async()=>{
  const {db,scenario,sandbox,cycle}=await setup('03');
  await cycle();
  const p=await one(db);assert.equal(p.state,'INDETERMINATE');
  await assert.rejects(cancelPayout(db,p.id,{rail:sandbox}),code('PAYOUT_NOT_CANCELLABLE'));
  await cycle();await cycle();
  assert.equal((await one(db)).state,'SETTLED');
  assert.equal(await sends(db,p.id),1,'found by key, never resent');assert.deepEqual(await attempts(db,p.id),['RESOLVED_FOUND']);
  await books(db,scenario,sandbox);
});

test('04: transient failures back off in simulated time, then succeed',async()=>{
  const {db,scenario,sandbox,cycle}=await setup('04');
  await runDueBatches(db,scenario);
  await runSettlementCycle(db,scenario,{rail:sandbox,random:()=>0.5});
  let p=await one(db);assert.equal(p.state,'RETRY');
  await runSettlementCycle(db,scenario,{rail:sandbox,random:()=>0.5});
  assert.equal(await sends(db,p.id),1,'not due again until the backoff passes in simulated time');
  for(let i=0;i<4;i++)await cycle();
  p=await one(db);
  assert.equal(p.state,'SETTLED');assert.deepEqual(await attempts(db,p.id),['TRANSIENT','TRANSIENT','ACCEPTED']);
  await books(db,scenario,sandbox);
});

test('05: rejected means confirmed unpaid: review, re-verification, the next batch skips the payee, cancel is allowed at once',async()=>{
  const {db,scenario,payee,sandbox,cycle,presenterBatch}=await setup('05');
  await cycle();
  const p=await one(db);
  assert.equal(p.state,'NEEDS_REVIEW');assert.equal(p.npc,true);assert.deepEqual(await attempts(db,p.id),['REJECTED']);
  assert.equal((await db.query('SELECT reverify_required FROM demo_payee_state WHERE payee_group_id=$1',[payee])).rows[0].reverify_required,true);
  assert.equal((await cancelPayout(db,p.id,{rail:sandbox})).state,'CANCELLED');
  await sellViaWebhook(db,{buyerId:'buyer-3'});
  const next=await presenterBatch();
  assert.equal(next.skippedReverify,1,'the batch saw the payee and skipped it');
  assert.equal((await payouts(db)).length,1,'skipped until re-verified');
  await books(db,scenario,sandbox);
});

test('06: a returned transfer reverses E12, releases the lots and requires re-verification',async()=>{
  const {db,scenario,payee,sandbox,cycle}=await setup('06');
  await cycle();await cycle();
  const p=await one(db);
  assert.equal(p.state,'RETURNED');assert.deepEqual(await lots(db),['RELEASED','RELEASED']);
  assert.equal(await balance(db,scenario,'payee_payable',payee),p.amount,'payable again');
  assert.equal((await db.query('SELECT reverify_required FROM demo_payee_state WHERE payee_group_id=$1',[payee])).rows[0].reverify_required,true);
  await books(db,scenario,sandbox);
});

test('10: rail down: transient until the attempts run out; cancel cannot be confirmed while the rail is down',async()=>{
  const {db,scenario,sandbox,cycle,advance}=await setup('10');
  for(let i=0;i<8;i++)await cycle();
  const p=await one(db);
  assert.equal(p.state,'NEEDS_REVIEW');assert.equal(await sends(db,p.id),6);
  await advance(86400);
  await assert.rejects(cancelPayout(db,p.id,{rail:sandbox}),code('RAIL_UNAVAILABLE'));
  assert.equal((await one(db)).state,'NEEDS_REVIEW');
  await books(db,scenario,sandbox);
});

test('11: processed late: the resend under the same key is the same transfer, settled once',async()=>{
  const {db,scenario,sandbox,cycle}=await setup('11');
  for(let i=0;i<4;i++)await cycle();
  const p=await one(db);
  assert.equal(p.state,'SETTLED');assert.equal(await sandbox.processedTransfers(p.id),1);
  assert.deepEqual(await attempts(db,p.id),['RESOLVED_ABSENT','ACCEPTED']);
  await books(db,scenario,sandbox);
});

test('12: a settlement for a different amount is not booked: review with AMOUNT_MISMATCH, no E13',async()=>{
  const {db,scenario,sandbox,cycle}=await setup('12');
  await cycle();await cycle();
  const p=await one(db);
  assert.equal(p.state,'NEEDS_REVIEW');assert.deepEqual(p.flags,['AMOUNT_MISMATCH']);assert.equal(p.npc,false);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM demo_journal_entries WHERE idempotency_key=$1`,[`PS:${p.id}`])).rows[0].n,0);
  assert.deepEqual(await lots(db),['IN_BATCH','IN_BATCH']);
  await books(db,scenario,sandbox);
});

test('a suffix change mid-retry does not change the payout: it keeps its token snapshot',async()=>{
  const {db,scenario,payee,sandbox,cycle}=await setup('04');
  await cycle();
  await setSuffix(db,payee,'00');
  for(let i=0;i<4;i++)await cycle();
  const p=await one(db);
  assert.equal(p.token,sandboxToken(payee,'04'));assert.equal(p.state,'SETTLED');
  assert.deepEqual(await attempts(db,p.id),['TRANSIENT','TRANSIENT','ACCEPTED'],'no CONFLICT from the rail');
  await books(db,scenario,sandbox);
});

test('unknown lookups for 24 simulated hours make a payout UNRESOLVED; it is still polled, and a cancel finds it was paid',async()=>{
  const {db,scenario,sandbox,cycle,advance}=await setup('03');
  const lookupsDown:PayoutRail={send:r=>sandbox.send(r),voidKey:c=>sandbox.voidKey(c),tick:s=>sandbox.tick(s),getByKey:async()=>{throw new RailUnknownError('RAIL_UNAVAILABLE');}};
  await cycle(lookupsDown);
  await advance(86400);await cycle(lookupsDown);
  const p=await one(db);assert.equal(p.state,'UNRESOLVED');
  // Past the window, so a cancel is attempted: the void says the money already went, so the payout follows the rail instead.
  await assert.rejects(cancelPayout(db,p.id,{rail:sandbox}),code('PAYOUT_PROCESSED'));
  assert.ok(['SENT','SETTLED'].includes((await one(db)).state));
  await cycle();
  assert.equal((await one(db)).state,'SETTLED');
  await books(db,scenario,sandbox);
});

test('a 30-day clock jump: an outcome found by key settles rather than going UNRESOLVED, and a live lease is untouched',async()=>{
  const {db,scenario,sandbox,cycle,advance,presenterBatch}=await setup('03');
  await cycle();
  await advance(30*86400);
  await cycle();await cycle();
  assert.equal((await one(db)).state,'SETTLED');
  // A sender that claimed a payout and is still inside its real-time lease is not disturbed by simulated time.
  await sellViaWebhook(db,{buyerId:'buyer-3'});
  await presenterBatch();
  const fresh=(await payouts(db)).find(p=>p.state==='PENDING')!;
  const claim=await beginSend(db,fresh.id,{leaseSeconds:3600});assert.ok(claim);
  await advance(30*86400);
  await runSettlementCycle(db,scenario,{rail:sandbox});
  assert.equal((await payouts(db)).find(p=>p.id===fresh.id)!.state,'IN_SETTLEMENT','lease measured in real time');
  assert.equal(await sends(db,fresh.id),0);
});

test('crash points: after the claim, after the rail call, during a resend, after the void: each is resolved by key, never blind',async()=>{
  const {db,scenario,sandbox,cycle,advance}=await setup('00',3);
  await runDueBatches(db,scenario);
  const expire=(id:string)=>db.query(`UPDATE demo_payouts SET lease_until_real=clock_timestamp()-interval '1 second' WHERE id=$1`,[id]);
  // 1. Crashed after claiming, before calling the rail.
  const p=(await one(db)).id;
  assert.ok(await beginSend(db,p,{leaseSeconds:60}));
  await expire(p);await cycle();
  assert.equal((await one(db)).state,'SENT');assert.deepEqual(await attempts(db,p),['RESOLVED_ABSENT','ACCEPTED']);assert.equal(await sends(db,p),1);
  await cycle();assert.equal((await one(db)).state,'SETTLED');
  const presenterRun=async()=>{const b=await createPresenterBatch(db,scenario,{requestId:crypto.randomUUID(),actorId:'presenter'});await runBatch(db,b.batchId);};
  // 2. Crashed after the rail accepted, before recording the outcome.
  await sellViaWebhook(db,{buyerId:'buyer-4'});await presenterRun();
  const q=(await payouts(db)).find(x=>x.state==='PENDING')!;
  const claim=await beginSend(db,q.id,{leaseSeconds:60});
  await sandbox.send({scenarioId:scenario,key:q.id,accountToken:q.token,amountPaise:q.amount});
  await expire(q.id);await cycle();
  assert.deepEqual(await attempts(db,q.id),['RESOLVED_FOUND']);assert.equal(await sends(db,q.id),1,'found, not resent');
  assert.ok(claim);
  // 3. Crashed during a resend: the resolver opened attempt 2 and stopped before calling the rail.
  await setSuffix(db,(await db.query('SELECT payee_group_id::text AS p FROM demo_payees')).rows[0].p,'02');
  await sellViaWebhook(db,{buyerId:'buyer-1'});await presenterRun();
  const r=(await payouts(db)).find(x=>x.state==='PENDING')!;
  await runSettlementCycle(db,scenario,{rail:sandbox,random:()=>0.5});
  assert.equal((await payouts(db)).find(x=>x.id===r.id)!.state,'INDETERMINATE');
  await advance(60);
  const resolving=await beginReconcile(db,r.id,{leaseSeconds:60});
  const next=await finishReconcile(db,r.id,resolving!,await sandbox.getByKey({scenarioId:scenario,key:r.id}),{leaseSeconds:60});
  assert.equal(next.kind,'RESEND');
  assert.equal(await sends(db,r.id),1);
  await expire(r.id);await runSettlementCycle(db,scenario,{rail:sandbox,random:()=>0.5});
  assert.deepEqual(await attempts(db,r.id),['RESOLVED_ABSENT','RESOLVED_ABSENT',null],'attempt 2 (crashed) found absent, attempt 3 sent');
  assert.equal(await sends(db,r.id),2,'the crashed resend was never sent; the next one was');
  // 4. Crashed after the void, before the cancel was recorded.
  for(let i=0;i<8;i++)await cycle();
  await advance(86400);
  assert.equal((await payouts(db)).find(x=>x.id===r.id)!.state,'NEEDS_REVIEW');
  await sandbox.voidKey({scenarioId:scenario,key:r.id});
  assert.equal((await cancelPayout(db,r.id,{rail:sandbox})).state,'CANCELLED');
  await books(db,scenario,sandbox);
});

test('a late answer from a sender whose lease expired is ignored once a resolver has taken over',async()=>{
  const {db,scenario,sandbox}=await setup('00');
  await runDueBatches(db,scenario);
  const p=(await one(db)).id;
  const stale=await beginSend(db,p,{leaseSeconds:60});assert.ok(stale);
  await db.query(`UPDATE demo_payouts SET lease_until_real=clock_timestamp()-interval '1 second' WHERE id=$1`,[p]);
  const resolving=await beginReconcile(db,p,{leaseSeconds:60});
  const next=await finishReconcile(db,p,resolving!,{kind:'NOT_FOUND'},{leaseSeconds:60});
  assert.equal(next.kind,'RESEND');
  // The first sender finally answers, about attempt 1: it must not touch attempt 2 or the payout.
  assert.equal(await finishSend(db,stale!,{kind:'TRANSIENT',code:'LATE'}),'STALE');
  assert.equal((await one(db)).state,'IN_SETTLEMENT');
  assert.deepEqual(await attempts(db,p),['RESOLVED_ABSENT',null]);
  assert.equal(await finishSend(db,(next as any).claim,await sandbox.send({scenarioId:scenario,key:p,accountToken:(next as any).claim.accountToken,amountPaise:(next as any).claim.amountPaise})),'SENT');
  await books(db,scenario,sandbox);
});

test('not found by key after the idempotency window confirms non-payment: no resend, and the payout can be cancelled at once',async()=>{
  const {db,scenario,sandbox,advance}=await setup('00');
  await runDueBatches(db,scenario);
  const p=(await one(db)).id;
  assert.ok(await beginSend(db,p,{leaseSeconds:60}));   // the sender died before calling the rail
  await advance(2*86400);
  await db.query(`UPDATE demo_payouts SET lease_until_real=clock_timestamp()-interval '1 second' WHERE id=$1`,[p]);
  await runSettlementCycle(db,scenario,{rail:sandbox,random:()=>0.5});
  const after=await one(db);
  assert.equal(after.state,'NEEDS_REVIEW');assert.equal(after.npc,true,'the window has passed and the rail has no such transfer');
  assert.equal(await sends(db,p),0,'never resent after the window');
  assert.equal((await cancelPayout(db,p,{rail:sandbox})).state,'CANCELLED');
  await books(db,scenario,sandbox);
});
