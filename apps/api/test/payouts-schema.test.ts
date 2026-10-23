import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Database} from '../src/kernel/database.js';
import {migrate} from '../src/kernel/migrate.js';
import {commissionPaise} from '../src/modules/market/domain/money.js';
import {earningJournals,journal,payoutBatched,payoutSettled} from '../src/modules/payouts/domain/postings.js';
import {canMovePayout,lotEventAllowed,PAYOUT_STATES,type LotState,type PayoutState} from '../src/modules/payouts/domain/state.js';
import {seedMarket,PRICE} from './support/market.js';
import {migratedPglite} from './support/pglite.js';
import {addBatch,addPayee,addPayout,balance,migratedTo,sandboxToken,sellDirect,writeJournal} from './support/payouts.js';
// Database guards of the payout slice (docs/23 §5, migration 0008). They must hold even if application code is wrong.
// They run on the schema as of 0008: from 0009 a ledger row commits only together with its earnings (payouts-earnings.test.ts),
// which would stop these tests from writing the lots and journals they probe by hand.
async function market(groups=2,perGroup=4){
  const {db}=await migratedTo(8);
  const m=await seedMarket(db,{groups,perGroup});
  return {db,m,scenario:m.scenario};
}
const earned=(ledger:{id:string;gross_paise:string;commission_paise:string;net_paise:string},payee:string,bps=2000)=>
  earningJournals({ledgerEntryId:ledger.id,payeeGroupId:payee,grossPaise:BigInt(ledger.gross_paise),commissionPaise:BigInt(ledger.commission_paise),netPaise:BigInt(ledger.net_paise),reserveBps:bps});
/** A sold credit, its payee, and a lot with its EARNED event: the starting point of a payout. */
async function earnedLot(db:Database,scenario:string,group:{capture:string;creditIds:string[]},commission=5002n){
  if(!(await db.query('SELECT 1 FROM demo_payees WHERE scenario_id=$1 AND payee_group_id=$2',[scenario,group.capture])).rows.length)await addPayee(db,scenario,group.capture);
  const sold=await sellDirect(db,{scenario,group,commissions:[commission]});
  const l=sold.ledger[0];
  await db.query(`INSERT INTO demo_earning_lots(ledger_entry_id,scenario_id,payee_group_id,net_paise,earned_sim,releasable_at_sim,holdback_days,reserve_bps,config_version) VALUES ($1,$2,$3,$4,now(),now(),7,2000,0)`,[l.id,scenario,group.capture,l.net_paise]);
  await db.query(`INSERT INTO demo_lot_events(ledger_entry_id,seq,scenario_id,state,at_sim) VALUES ($1,1,$2,'EARNED',now())`,[l.id,scenario]);
  return l;
}
const batch=addBatch,payout=addPayout;
const move=(db:Database,id:string,state:string,extra='')=>db.query(`UPDATE demo_payouts SET state=$2${extra} WHERE id=$1`,[id,state]);

test('half_even_bps in SQL agrees with the application helper, including exact ties',async()=>{
  const {db}=await migratedPglite();
  const cases:[bigint,number][]=[[4n,1250],[12n,1250],[5001n,5000],[5003n,5000],[5002n,2000],[0n,2000],[1n,10000],[999_999_999_999n,1],[7n,0]];
  for(let i=0;i<200;i++)cases.push([BigInt(i*37+1),[1,2000,2500,5000,7500,9999][i%6]]);
  const r=await db.query(`SELECT half_even_bps(a::bigint,b::integer)::text AS v FROM unnest($1::text[],$2::int[]) WITH ORDINALITY AS x(a,b,o) ORDER BY o`,[cases.map(c=>String(c[0])),cases.map(c=>c[1])]);
  assert.deepEqual(r.rows.map(x=>BigInt(x.v)),cases.map(([a,b])=>commissionPaise(a,b)));
  await assert.rejects(db.query('SELECT half_even_bps(1,10001)'));await assert.rejects(db.query('SELECT half_even_bps(-1,10)'));
});

test('configuration is per scenario, bounded and insert-only; the clock moves forward only and within a year',async()=>{
  const {db,scenario}=await market(1,1);
  const config=(v:number,over:Record<string,number>={})=>{const c={holdback:7,reserve:2000,min:10000,limit:5000000,base:5,window:86400,...over};
    return db.query(`INSERT INTO demo_ledger_config(scenario_id,version,holdback_days,reserve_bps,min_payout_paise,payout_limit_paise,backoff_base_seconds,idempotency_window_seconds,effective_from,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),'presenter')`,
      [scenario,v,c.holdback,c.reserve,c.min,c.limit,c.base,c.window]);};
  await config(1);
  await assert.rejects(config(1),'versions are unique');await assert.rejects(config(0),'version 0 is the built-in default, never a row');
  for(const bad of [{reserve:10001},{reserve:-1},{holdback:-1},{min:0},{limit:9999},{base:0},{window:0}] as Record<string,number>[])await assert.rejects(config(2,bad),JSON.stringify(bad));
  await config(2,{reserve:0,holdback:0,limit:10000});
  await assert.rejects(db.query('UPDATE demo_ledger_config SET reserve_bps=1'));await assert.rejects(db.query('DELETE FROM demo_ledger_config'));

  await db.query('INSERT INTO demo_clock(scenario_id,offset_seconds) VALUES ($1,0)',[scenario]);
  await db.query('UPDATE demo_clock SET offset_seconds=86400 WHERE scenario_id=$1',[scenario]);
  await assert.rejects(db.query('UPDATE demo_clock SET offset_seconds=3600 WHERE scenario_id=$1',[scenario]),/forward/);
  await assert.rejects(db.query('UPDATE demo_clock SET offset_seconds=31536001 WHERE scenario_id=$1',[scenario]));
  await db.query('UPDATE demo_clock SET offset_seconds=31536000 WHERE scenario_id=$1',[scenario]);
  await assert.rejects(db.query('DELETE FROM demo_clock'));
  await assert.rejects(db.query(`INSERT INTO demo_clock(scenario_id,offset_seconds) VALUES ('no-such-scenario',0)`));
});

test('payees hold only a synthetic sandbox token; only its suffix changes, and every change leaves a history row',async()=>{
  const {db,m,scenario}=await market(1,1);const p=m.groups[0].capture;
  await assert.rejects(db.query(`INSERT INTO demo_payees(scenario_id,payee_group_id,account_token,verified_at) VALUES ($1,$2,'123456789012',now())`,[scenario,p]),'an account-like number is not a token');
  await assert.rejects(db.query(`INSERT INTO demo_payees(scenario_id,payee_group_id,account_token,verified_at) VALUES ($1,$2,$3,now())`,[scenario,p,sandboxToken(p,'99')]),'unknown suffix');
  await addPayee(db,scenario,p);
  await db.query('UPDATE demo_payees SET account_token=$2 WHERE payee_group_id=$1',[p,sandboxToken(p,'05')]);
  await assert.rejects(db.query('UPDATE demo_payees SET account_token=$2 WHERE payee_group_id=$1',[p,'SANDBOX-FFFFFFFF-05']),'the stem is fixed');
  await assert.rejects(db.query('UPDATE demo_payees SET payee_group_id=$2 WHERE payee_group_id=$1',[p,randomUUID()]));
  await assert.rejects(db.query('DELETE FROM demo_payees'));await assert.rejects(db.query('DELETE FROM demo_payee_state'));
  const h=await db.query('SELECT old_token,new_token FROM demo_payee_token_history WHERE payee_group_id=$1',[p]);
  assert.deepEqual(h.rows,[{old_token:sandboxToken(p,'00'),new_token:sandboxToken(p,'05')}]);
  await assert.rejects(db.query('UPDATE demo_payee_token_history SET new_token=old_token'));
  await db.query('UPDATE demo_payee_state SET reverify_required=true WHERE payee_group_id=$1',[p]);
});

test('a journal balances, matches its declared size, uses the accounts of its kind, and never changes',async()=>{
  const {db,m,scenario}=await market();const p=m.groups[0].capture;await addPayee(db,scenario,p);
  const l=(await sellDirect(db,{scenario,group:m.groups[0],commissions:[5002n,5002n,5002n]})).ledger;
  const good=earned(l[0],p);
  await db.transaction(async tx=>{await writeJournal(tx,scenario,good.earned,{ledgerEntryId:l[0].id});await writeJournal(tx,scenario,good.funded!,{ledgerEntryId:l[0].id,basisBps:2000});});
  assert.equal(await balance(db,scenario,'payee_payable',p),95028n);assert.equal(await balance(db,scenario,'reversal_reserve'),1000n);
  assert.equal(await balance(db,scenario,'commission_revenue'),4002n);assert.equal(await balance(db,scenario,'buyer_funds_clearing'),-100030n);
  const commitFails=(work:(tx:Database)=>Promise<unknown>,why:string,pattern:RegExp=/journal/)=>assert.rejects(db.transaction(work),pattern,why);
  const e1=earned(l[1],p);
  await commitFails(tx=>writeJournal(tx,scenario,e1.earned,{ledgerEntryId:l[1].id,lineCount:4}),'declared 4 lines, wrote 3');
  await commitFails(tx=>writeJournal(tx,scenario,e1.earned,{ledgerEntryId:l[1].id,totalPaise:100031n}),'declared total differs');
  await commitFails(tx=>writeJournal(tx,scenario,{...e1.earned,lines:[]},{ledgerEntryId:l[1].id,lineCount:3}),'an entry with no lines');
  await commitFails(tx=>writeJournal(tx,scenario,{...e1.earned,lines:[e1.earned.lines[0],{...e1.earned.lines[1],amountPaise:95027n},e1.earned.lines[2]]},{ledgerEntryId:l[1].id,totalPaise:100030n}),'unbalanced');
  await commitFails(tx=>writeJournal(tx,scenario,{...e1.earned,lines:[e1.earned.lines[0],{...e1.earned.lines[1],account:'bank_cash',payeeGroupId:undefined},e1.earned.lines[2]]},{ledgerEntryId:l[1].id}),'bank_cash is not an EARNED account');
  await commitFails(tx=>writeJournal(tx,scenario,{...e1.earned,key:`EARN:${l[2].id}`},{ledgerEntryId:l[1].id}),'the key names a different ledger row',/idempotency_key|check/);
  await commitFails(tx=>writeJournal(tx,scenario,e1.earned,{ledgerEntryId:l[1].id,payoutId:randomUUID()}),'an earning carries no payout',/check|foreign|journal/);
  await commitFails(tx=>writeJournal(tx,scenario,e1.funded!,{ledgerEntryId:l[1].id}),'a reserve journal records its basis',/check/);
  await commitFails(tx=>writeJournal(tx,scenario,e1.earned,{ledgerEntryId:l[1].id,basisBps:2000}),'only reserve journals carry a basis',/check/);
  await commitFails(tx=>writeJournal(tx,scenario,good.earned,{ledgerEntryId:l[0].id}),'one journal per key',/duplicate|unique/);
  // A line added after the journal committed breaks its declared size.
  const jid=(await db.query(`SELECT id FROM demo_journal_entries WHERE idempotency_key=$1`,[good.earned.key])).rows[0].id;
  await commitFails(tx=>tx.query(`INSERT INTO demo_journal_lines(journal_id,scenario_id,line_no,account,side,amount_paise) VALUES ($1,$2,9,'commission_revenue','CR',1)`,[jid,scenario]),'a late line');
  await assert.rejects(db.query(`UPDATE demo_journal_lines SET amount_paise=amount_paise+1 WHERE journal_id=$1`,[jid]));
  await assert.rejects(db.query(`UPDATE demo_journal_entries SET total_paise=1 WHERE id=$1`,[jid]));await assert.rejects(db.query('DELETE FROM demo_journal_lines'));await assert.rejects(db.query('DELETE FROM demo_journal_entries'));
  // Lines carry a payee exactly when they are payee_payable, and the payee must exist in the same scenario.
  await commitFails(tx=>writeJournal(tx,scenario,{...e1.earned,lines:[e1.earned.lines[0],{...e1.earned.lines[1],payeeGroupId:undefined},e1.earned.lines[2]]},{ledgerEntryId:l[1].id}),'payable without payee',/check/);
  await commitFails(tx=>writeJournal(tx,scenario,earned(l[1],randomUUID()).earned,{ledgerEntryId:l[1].id}),'unknown payee',/foreign/);
  await db.query(`INSERT INTO scenarios(id) VALUES ('other')`);await db.query(`INSERT INTO demo_namespaces(scenario_id) VALUES ('other')`);
  await commitFails(tx=>writeJournal(tx,'other',e1.earned,{ledgerEntryId:l[1].id}),'a journal cannot cite another scenario\'s ledger row',/foreign/);
  // Zero-line journals are never built (the domain returns null), so the guard never meets them; 0 and 10000 bps both post.
  assert.equal(journal('RESERVE_FUNDED','x',[{account:'commission_revenue',side:'DR',amountPaise:0n},{account:'reversal_reserve',side:'CR',amountPaise:0n}]),null);
  await db.transaction(tx=>writeJournal(tx,scenario,e1.earned,{ledgerEntryId:l[1].id}));
});

test('lots copy their ledger row, follow the holdback rule, and never change',async()=>{
  const {db,m,scenario}=await market();const p=m.groups[0].capture;await addPayee(db,scenario,p);await addPayee(db,scenario,m.groups[1].capture);
  const l=(await sellDirect(db,{scenario,group:m.groups[0],commissions:[5002n,PRICE]})).ledger;
  const lot=(over:Record<string,unknown>={})=>{const v={id:l[0].id,payee:p,net:l[0].net_paise,released:'now()',holdback:7,...over};
    return db.query(`INSERT INTO demo_earning_lots(ledger_entry_id,scenario_id,payee_group_id,net_paise,earned_sim,releasable_at_sim,holdback_days,reserve_bps,config_version) VALUES ($1,$2,$3,$4,now(),${v.released},$5,2000,0)`,[v.id,scenario,v.payee,v.net,v.holdback]);};
  await assert.rejects(lot({net:'95027'}),/ledger/,'net must equal the ledger row');
  await assert.rejects(lot({payee:m.groups[1].capture}),/ledger/,'payee must be the ledger row\'s group');
  await assert.rejects(lot({released:`now()+interval '3 days'`}),'releasable is earned or earned + holdback');
  await assert.rejects(lot({id:l[1].id,net:'0'}),'a zero-net sale has no lot');
  await lot({released:`now()+interval '7 days'`});
  await assert.rejects(lot(),'one lot per ledger row');
  await assert.rejects(db.query('UPDATE demo_earning_lots SET releasable_at_sim=earned_sim'));await assert.rejects(db.query('DELETE FROM demo_earning_lots'));
});

test('lot events follow the lot machine and agree with the payout they name',async()=>{
  const {db,m,scenario}=await market(1,4);const p=m.groups[0].capture;
  const a=await earnedLot(db,scenario,m.groups[0]);
  const event=(id:string,seq:number,state:LotState,payoutId:string|null)=>db.query(`INSERT INTO demo_lot_events(ledger_entry_id,seq,scenario_id,state,payout_id,at_sim) VALUES ($1,$2,$3,$4,$5,now())`,[id,seq,scenario,state,payoutId]);
  const b=await batch(db,scenario),po=await payout(db,scenario,b,p,BigInt(a.net_paise));
  await assert.rejects(event(a.id,2,'IN_BATCH',po),/item/,'batched only with an active item');
  await db.query('INSERT INTO demo_payout_items(payout_id,ledger_entry_id,scenario_id) VALUES ($1,$2,$3)',[po,a.id,scenario]);
  await assert.rejects(event(a.id,3,'IN_BATCH',po),/sequence/,'no gaps');
  await assert.rejects(event(a.id,2,'PAID',po),'EARNED -> PAID skips the batch');
  await event(a.id,2,'IN_BATCH',po);
  await assert.rejects(event(a.id,3,'PAID',po),/SETTLED/,'paid only once the payout settled');
  await move(db,po,'IN_SETTLEMENT');await move(db,po,'SETTLED');
  await assert.rejects(event(a.id,3,'PAID',randomUUID()),'paid by the payout that batched it');
  await assert.rejects(event(a.id,3,'RELEASED',po),/CANCELLED|RETURNED/,'released only by a cancelled or returned payout');
  await event(a.id,3,'PAID',po);
  await assert.rejects(event(a.id,4,'RELEASED',po));
  await assert.rejects(db.query(`UPDATE demo_lot_events SET state='EARNED'`));await assert.rejects(db.query('DELETE FROM demo_lot_events'));
  assert.ok(!lotEventAllowed('PAID','RELEASED')&&!lotEventAllowed('EARNED','PAID'),'the application table agrees');
});

test('payout transitions in the database match the application machine pair by pair',async()=>{
  const {db,m,scenario}=await market(1,1);const p=m.groups[0].capture;await addPayee(db,scenario,p);
  const path:Record<PayoutState,[PayoutState,boolean][]>={PENDING:[],IN_SETTLEMENT:[['IN_SETTLEMENT',false]],SENT:[['IN_SETTLEMENT',false],['SENT',false]],SETTLED:[['IN_SETTLEMENT',false],['SETTLED',false]],
    RETRY:[['IN_SETTLEMENT',false],['RETRY',false]],INDETERMINATE:[['IN_SETTLEMENT',false],['INDETERMINATE',false]],UNRESOLVED:[['IN_SETTLEMENT',false],['INDETERMINATE',false],['UNRESOLVED',false]],
    NEEDS_REVIEW:[['IN_SETTLEMENT',false],['NEEDS_REVIEW',false]],RETURNED:[['IN_SETTLEMENT',false],['SENT',false],['RETURNED',false]],CANCELLED:[['IN_SETTLEMENT',false],['NEEDS_REVIEW',true],['CANCELLED',true]]};
  let checked=0;
  for(const from of PAYOUT_STATES)for(const confirmed of [false,true]){
    // Combinations that cannot exist: confirmed-unpaid is never sent, settled or returned, and every cancel is confirmed.
    if(confirmed&&(['SENT','SETTLED','RETURNED'] as PayoutState[]).includes(from))continue;
    if(!confirmed&&from==='CANCELLED')continue;
    const b=await batch(db,scenario,{runSeq:++checked,requestId:randomUUID()}),id=await payout(db,scenario,b,p);
    for(const [state,npc] of path[from])await move(db,id,state,npc?',non_payment_confirmed=true':'');
    if(confirmed&&from!=='CANCELLED')await db.query('UPDATE demo_payouts SET non_payment_confirmed=true WHERE id=$1',[id]);
    for(const to of PAYOUT_STATES)if(to!==from){
      const expected=canMovePayout(from,to,{nonPaymentConfirmed:confirmed});
      await db.exec!('BEGIN');
      try{await move(db,id,to);assert.ok(expected,`database allowed ${from} -> ${to} (confirmed=${confirmed})`);}
      catch(error){if(error instanceof assert.AssertionError)throw error;assert.ok(!expected,`database refused ${from} -> ${to} (confirmed=${confirmed}): ${(error as Error).message}`);}
      finally{await db.exec!('ROLLBACK');}
    }
  }
  assert.ok(checked>=14);
});

test('payout identity, amounts and the confirmed-unpaid flag are protected',async()=>{
  const {db,m,scenario}=await market(1,1);const p=m.groups[0].capture;await addPayee(db,scenario,p);
  const b=await batch(db,scenario),id=await payout(db,scenario,b,p);
  await assert.rejects(payout(db,scenario,b,p),'one payout per payee per batch');
  await assert.rejects(db.query(`INSERT INTO demo_payouts(id,batch_id,scenario_id,payee_group_id,account_token,gross_paise,amount_paise,state) VALUES ($1,$2,$3,$4,$5,1,1,'SENT')`,[randomUUID(),await batch(db,scenario,{runSeq:1}),scenario,p,sandboxToken(p)]),'payouts start PENDING');
  await assert.rejects(db.query(`INSERT INTO demo_payouts(id,batch_id,scenario_id,payee_group_id,account_token,gross_paise,amount_paise) VALUES ($1,$2,$3,$4,$5,1,1)`,[randomUUID(),await batch(db,scenario,{runSeq:2}),scenario,p,sandboxToken(p,'05')]),/token/,'the snapshot is the payee\'s current token');
  await assert.rejects(db.query(`INSERT INTO demo_payouts(id,batch_id,scenario_id,payee_group_id,account_token,gross_paise,recovery_paise,amount_paise) VALUES ($1,$2,$3,$4,$5,10,1,9)`,[randomUUID(),await batch(db,scenario,{runSeq:3}),scenario,p,sandboxToken(p)]),'no recovery in the demo');
  for(const change of ['amount_paise=1','gross_paise=1',`account_token='${sandboxToken(p,'05')}'`,`payee_group_id='${randomUUID()}'`,'batch_id=gen_random_uuid()'])
    await assert.rejects(db.query(`UPDATE demo_payouts SET ${change} WHERE id=$1`,[id]),change);
  await move(db,id,'IN_SETTLEMENT');await move(db,id,'NEEDS_REVIEW',',non_payment_confirmed=true');
  await assert.rejects(db.query('UPDATE demo_payouts SET non_payment_confirmed=false WHERE id=$1',[id]),/confirmed/,'never reset');
  await assert.rejects(move(db,id,'SETTLED'),'confirmed unpaid cannot settle');
  await db.query(`UPDATE demo_payouts SET first_request_sim=now() WHERE id=$1`,[id]);
  await assert.rejects(db.query(`UPDATE demo_payouts SET first_request_sim=now()+interval '1 hour' WHERE id=$1`,[id]),'first request is set once');
  await assert.rejects(db.query('UPDATE demo_payouts SET attempts=7 WHERE id=$1',[id]),'six attempts at most');
  await move(db,id,'CANCELLED');
  await assert.rejects(db.query(`UPDATE demo_payouts SET flags=ARRAY['X'] WHERE id=$1`,[id]),/final/);
  await assert.rejects(db.query('DELETE FROM demo_payouts'));
});

test('batches: one scheduled run a day, presenter runs keyed by request, run date in IST, status forward only',async()=>{
  const {db,scenario}=await market(1,1);
  await batch(db,scenario,{asOfSim:'2026-10-23T18:29:00Z'});
  await assert.rejects(batch(db,scenario,{asOfSim:'2026-10-23T10:00:00Z'}),'second scheduled run on the same IST day');
  await batch(db,scenario,{asOfSim:'2026-10-23T18:30:00Z'});
  const days=await db.query(`SELECT run_date::text AS d FROM demo_payout_batches ORDER BY as_of_sim`);
  assert.deepEqual(days.rows.map(r=>r.d),['2026-10-23','2026-10-24'],'18:30 UTC is midnight in Kolkata');
  const request=randomUUID();await batch(db,scenario,{runSeq:1,requestId:request});
  await assert.rejects(batch(db,scenario,{runSeq:2,requestId:request}),'a request id makes one run');
  await assert.rejects(batch(db,scenario,{runSeq:3,requestId:null}),'presenter runs carry a request id');
  await assert.rejects(batch(db,scenario,{runSeq:0,requestId:randomUUID(),asOfSim:'2026-11-01T00:00:00Z'}),'the scheduled run has none');
  await assert.rejects(db.query(`INSERT INTO demo_payout_batches(id,scenario_id,run_date,run_seq,as_of_sim,as_of_real,min_payout_paise,payout_limit_paise,config_version,status,created_by) VALUES ($1,$2,'2026-01-01',0,'2026-10-23T00:00:00Z',now(),1,1,0,'RUNNING','worker')`,[randomUUID(),scenario]),'run date must follow the simulated time');
  const id=(await db.query(`SELECT id FROM demo_payout_batches WHERE run_seq=1`)).rows[0].id;
  await db.query(`UPDATE demo_payout_batches SET status='PARTIAL' WHERE id=$1`,[id]);await db.query(`UPDATE demo_payout_batches SET status='RUNNING' WHERE id=$1`,[id]);
  await db.query(`UPDATE demo_payout_batches SET status='COMPLETED',finished_at=now() WHERE id=$1`,[id]);
  await assert.rejects(db.query(`UPDATE demo_payout_batches SET status='RUNNING' WHERE id=$1`,[id]));
  await assert.rejects(db.query(`UPDATE demo_payout_batches SET min_payout_paise=1 WHERE run_seq=0`),'the snapshot is immutable');
  await assert.rejects(db.query('DELETE FROM demo_payout_batches'));
});

test('items: a lot is in one live payout at a time, of its own payee; attempts: one open at a time, outcomes set once',async()=>{
  const {db,m,scenario}=await market(2,4);const p=m.groups[0].capture,q=m.groups[1].capture;
  const a=await earnedLot(db,scenario,m.groups[0]);await addPayee(db,scenario,q);
  const b1=await batch(db,scenario),po=await payout(db,scenario,b1,p,BigInt(a.net_paise)),pq=await payout(db,scenario,b1,q,BigInt(a.net_paise));
  const item=(payoutId:string)=>db.query('INSERT INTO demo_payout_items(payout_id,ledger_entry_id,scenario_id) VALUES ($1,$2,$3)',[payoutId,a.id,scenario]);
  await assert.rejects(item(pq),/payee/,'another payee\'s payout');
  await item(po);
  const b2=await batch(db,scenario,{runSeq:1}),again=await payout(db,scenario,b2,p,BigInt(a.net_paise));
  await assert.rejects(item(again),/unique|duplicate/,'already in a live payout');
  await assert.rejects(db.query('UPDATE demo_payout_items SET active=false WHERE payout_id=$1',[po]),/CANCELLED|RETURNED/,'released only with the payout');
  await move(db,po,'IN_SETTLEMENT');await move(db,po,'NEEDS_REVIEW',',non_payment_confirmed=true');await move(db,po,'CANCELLED');
  await db.query('UPDATE demo_payout_items SET active=false WHERE payout_id=$1',[po]);
  await assert.rejects(db.query('UPDATE demo_payout_items SET active=true WHERE payout_id=$1',[po]),'never reactivated');
  await move(db,again,'IN_SETTLEMENT');
  await assert.rejects(item(again),/PENDING/,'items are added only while the payout is being built');
  const b3=await batch(db,scenario,{runSeq:2}),fresh=await payout(db,scenario,b3,p,BigInt(a.net_paise));await item(fresh);
  await assert.rejects(db.query('DELETE FROM demo_payout_items'));

  const attempt=(no:number)=>db.query(`INSERT INTO demo_payout_attempts(payout_id,attempt_no,scenario_id,requested_at_sim) VALUES ($1,$2,$3,now())`,[fresh,no,scenario]);
  await assert.rejects(attempt(2),/sequence/,'numbered from 1 without gaps');
  await attempt(1);
  await assert.rejects(attempt(2),/unique|duplicate|open/,'one open attempt per payout');
  await db.query(`UPDATE demo_payout_attempts SET outcome_at=now(),class='RESOLVED_ABSENT' WHERE payout_id=$1 AND attempt_no=1`,[fresh]);
  await assert.rejects(db.query(`UPDATE demo_payout_attempts SET class='ACCEPTED' WHERE payout_id=$1 AND attempt_no=1`,[fresh]),/once/);
  await assert.rejects(db.query(`UPDATE demo_payout_attempts SET outcome_at=now() WHERE payout_id=$1 AND attempt_no=1`,[fresh]),/once/);
  await attempt(2);
  await assert.rejects(db.query(`UPDATE demo_payout_attempts SET outcome_at=now() WHERE payout_id=$1 AND attempt_no=2`,[fresh]),'outcome and class together');
  await db.query(`UPDATE demo_payout_attempts SET outcome_at=now(),class='ACCEPTED',rail_ref='r-1' WHERE payout_id=$1 AND attempt_no=2`,[fresh]);
  await assert.rejects(db.query('DELETE FROM demo_payout_attempts'));
});

test('0008 backfills existing sales: payees, lots and balanced EARN/FUND journals that reconcile to the ledger',async()=>{
  const {db}=await migratedTo(7);
  const m=await seedMarket(db,{groups:2,perGroup:5});const [g1,g2]=m.groups;
  // Normal, 0% and 100% commission, and a tiny commission whose reserve share rounds to 0.
  const first=await sellDirect(db,{scenario:m.scenario,group:g1,commissions:[5002n,0n]});
  const second=await sellDirect(db,{scenario:m.scenario,group:g2,commissions:[PRICE,2n,5000n]});
  await migrate(db);
  const ledger=[...first.ledger.map(l=>({...l,payee:g1.capture})),...second.ledger.map(l=>({...l,payee:g2.capture}))];
  const payees=await db.query('SELECT p.payee_group_id::text AS id,p.account_token,s.reverify_required FROM demo_payees p JOIN demo_payee_state s USING (scenario_id,payee_group_id) ORDER BY 1');
  assert.deepEqual(payees.rows,[g1.capture,g2.capture].sort().map(id=>({id,account_token:sandboxToken(id),reverify_required:false})));
  const lots=await db.query(`SELECT l.ledger_entry_id::text AS id,l.net_paise::text AS net,l.releasable_at_sim=e.created_at AND l.earned_sim=e.created_at AS immediate,l.holdback_days,l.config_version,ev.state
    FROM demo_earning_lots l JOIN demo_ledger_entries e ON e.id=l.ledger_entry_id JOIN demo_lot_events ev ON ev.ledger_entry_id=l.ledger_entry_id ORDER BY l.ledger_entry_id`);
  assert.deepEqual(lots.rows,ledger.filter(l=>l.net_paise!=='0').map(l=>({id:l.id,net:l.net_paise,immediate:true,holdback_days:0,config_version:0,state:'EARNED'})),'no lot for the 100% commission sale');
  const journals=await db.query('SELECT idempotency_key AS key,payload_hash AS hash,line_count,total_paise::text AS total,basis_bps FROM demo_journal_entries ORDER BY id');
  const expected=ledger.flatMap(l=>{const j=earned(l,l.payee);return [{key:j.earned.key,hash:j.earned.payloadHash,line_count:j.earned.lines.length,total:String(j.earned.totalPaise),basis_bps:null},
    ...(j.funded?[{key:j.funded.key,hash:j.funded.payloadHash,line_count:2,total:String(j.funded.totalPaise),basis_bps:2000}]:[])];});
  assert.deepEqual(new Set(journals.rows.map(r=>JSON.stringify(r))),new Set(expected.map(r=>JSON.stringify(r))),'same keys, sizes and payload hashes as the application builds');
  assert.equal(journals.rows.length,expected.length);
  for(const g of [g1,g2])assert.equal(await balance(db,m.scenario,'payee_payable',g.capture),ledger.filter(l=>l.payee===g.capture).reduce((n,l)=>n+BigInt(l.net_paise),0n));
  assert.equal(await balance(db,m.scenario,'reversal_reserve'),ledger.reduce((n,l)=>n+commissionPaise(BigInt(l.commission_paise),2000),0n));
  assert.equal(-(await balance(db,m.scenario,'buyer_funds_clearing')),PRICE*5n);
});

test('payout journals use their own keys and accounts',async()=>{
  const {db,m,scenario}=await market(1,1);const p=m.groups[0].capture;await addPayee(db,scenario,p);
  const b=await batch(db,scenario),id=await payout(db,scenario,b,p,500n);
  await assert.rejects(db.transaction(tx=>writeJournal(tx,scenario,payoutBatched(id,p,500n))),/check/,'a payout journal names its payout');
  await assert.rejects(db.transaction(tx=>writeJournal(tx,scenario,payoutBatched(randomUUID(),p,500n),{payoutId:id})),/check/,'key and payout agree');
  await db.transaction(async tx=>{await writeJournal(tx,scenario,{...payoutBatched(id,p,500n)},{payoutId:id});});
  await assert.rejects(db.transaction(tx=>writeJournal(tx,scenario,{...payoutSettled(id,500n),lines:payoutSettled(id,500n).lines.map(l=>l.account==='bank_cash'?{...l,account:'reversal_reserve' as const}:l)},{payoutId:id})),/account/);
  assert.equal(await balance(db,scenario,'payout_clearing'),500n);assert.equal(await balance(db,scenario,'payee_payable',p),-500n);
});
