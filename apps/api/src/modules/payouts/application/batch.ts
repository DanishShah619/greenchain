import {randomUUID} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
import {selectLots} from '../domain/batch.js';
import {payoutBatched} from '../domain/postings.js';
import {simNow} from './clock.js';
import {readLedgerConfig} from './earnings.js';
import {postJournals} from './journal.js';
/**
 * The payout batcher (docs/23 §6.2, P8). A batch is a run for one simulated IST day: run_seq 0 is the worker's scheduled run,
 * presenter runs are 1, 2, ... and keyed by request id. Each payee is batched in its own short transaction under the payee
 * lock (lock order step 5, then the new payout), so one slow or locked payee never holds the others, and a crash leaves a
 * RUNNING batch that the worker resumes. The batch's own snapshot (simulated time, minimum, limit) decides eligibility, so a
 * resumed run makes the same decisions.
 */
export type BatchSummary={batchId:string;runDate:string;runSeq:number;status:'COMPLETED'|'PARTIAL';payouts:number;rolledOver:number;skippedReverify:number;oversizedLots:number;failedPayees:number};
export type PayeeOutcome='PAID'|'ROLLED_OVER'|'NOTHING_RELEASABLE'|'REVERIFY_REQUIRED'|'ALREADY_BATCHED';
type BatchRow={id:string;scenario_id:string;run_date:string;run_seq:number;as_of_sim:Date;min_payout_paise:string;payout_limit_paise:string;status:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BATCH_COLUMNS=`id::text AS id,scenario_id,run_date::text AS run_date,run_seq,as_of_sim,min_payout_paise::text AS min_payout_paise,payout_limit_paise::text AS payout_limit_paise,status`;
/** Serialises batch creation per scenario (run_seq allocation and request-id replay). Touches nothing else. */
const lockBatchCreation=(tx:Database,scenarioId:string)=>tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('greenchain:payout-batch:'||$1,0))`,[scenarioId]);
async function insertBatch(tx:Database,scenarioId:string,runSeq:number|null,requestId:string|null,createdBy:string){
  const time=await simNow(tx,scenarioId),config=await readLedgerConfig(tx,scenarioId,time.sim);
  return (await tx.query(`INSERT INTO demo_payout_batches(id,scenario_id,run_date,run_seq,request_id,as_of_sim,as_of_real,min_payout_paise,payout_limit_paise,config_version,status,created_by)
    SELECT $1,$2,d,coalesce($3::int,(SELECT coalesce(max(run_seq),0)+1 FROM demo_payout_batches WHERE scenario_id=$2 AND run_date=d)),$4,$5,$6,$7,$8,$9,'RUNNING',$10
    FROM (SELECT ($5::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AS d) x
    ON CONFLICT (scenario_id,run_date,run_seq) DO NOTHING RETURNING ${BATCH_COLUMNS}`,
    [randomUUID(),scenarioId,runSeq,requestId,time.sim,time.real,String(config.minPayoutPaise),String(config.payoutLimitPaise),config.version,createdBy])).rows[0] as BatchRow|undefined;
}
/** The worker's run for the current simulated day; created once per day (a database fact, so it survives restarts). */
export async function ensureScheduledBatch(db:Database,scenarioId:string):Promise<{batchId:string;created:boolean}>{
  return db.transaction(async tx=>{
    const created=await insertBatch(tx,scenarioId,0,null,'worker');
    if(created)return {batchId:created.id,created:true};
    const time=await simNow(tx,scenarioId);
    const existing=(await tx.query(`SELECT id::text AS id FROM demo_payout_batches WHERE scenario_id=$1 AND run_seq=0 AND run_date=($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`,[scenarioId,time.sim])).rows[0];
    return {batchId:existing.id as string,created:false};
  });
}
/** A presenter run for the current simulated day; the same request id always returns the same batch. */
export async function createPresenterBatch(db:Database,scenarioId:string,input:{requestId:string;actorId:string},audit?:(tx:Database,batchId:string)=>Promise<unknown>):Promise<{batchId:string;runSeq:number;runDate:string;replayed:boolean}>{
  if(typeof input.requestId!=='string'||!UUID.test(input.requestId))throw new WorkflowError('VALIDATION_FAILED',422);
  return db.transaction(async tx=>{
    await lockBatchCreation(tx,scenarioId);
    const existing=(await tx.query(`SELECT ${BATCH_COLUMNS} FROM demo_payout_batches WHERE scenario_id=$1 AND request_id=$2`,[scenarioId,input.requestId])).rows[0] as BatchRow|undefined;
    if(existing)return {batchId:existing.id,runSeq:existing.run_seq,runDate:existing.run_date,replayed:true};
    const created=await insertBatch(tx,scenarioId,null,input.requestId,input.actorId);
    if(!created)throw new WorkflowError('BATCH_CONFLICT',409);
    await audit?.(tx,created.id);
    return {batchId:created.id,runSeq:created.run_seq,runDate:created.run_date,replayed:false};
  });
}
const loadBatch=async(db:Database,batchId:string)=>{
  const b=(await db.query(`SELECT ${BATCH_COLUMNS} FROM demo_payout_batches WHERE id=$1`,[batchId])).rows[0] as BatchRow|undefined;
  if(!b)throw new WorkflowError('NOT_FOUND',404);
  return b;
};
/**
 * One payee in one batch, in one transaction: payee lock, then (if eligible) the payout, its items, IN_BATCH events and E12.
 * Idempotent: a payee that already has a payout in this batch is left alone.
 */
export async function batchPayee(db:Database,batchId:string,payeeGroupId:string,result?:{oversized:number}):Promise<PayeeOutcome>{
  const batch=await loadBatch(db,batchId);
  return db.transaction(async tx=>{
    await tx.query(`SET LOCAL lock_timeout = '3s'`);
    const state=(await tx.query('SELECT reverify_required FROM demo_payee_state WHERE scenario_id=$1 AND payee_group_id=$2 FOR UPDATE',[batch.scenario_id,payeeGroupId])).rows[0];
    if(!state)return 'NOTHING_RELEASABLE';
    if(state.reverify_required)return 'REVERIFY_REQUIRED';
    if((await tx.query('SELECT 1 FROM demo_payouts WHERE batch_id=$1 AND payee_group_id=$2',[batchId,payeeGroupId])).rows.length)return 'ALREADY_BATCHED';
    // Releasable lots of this payee, oldest first: latest event EARNED or RELEASED, releasable at the batch's simulated time.
    const lots=(await tx.query(`SELECT l.ledger_entry_id::text AS id,l.net_paise::text AS net,e.seq FROM demo_earning_lots l
      JOIN LATERAL (SELECT state,seq FROM demo_lot_events WHERE ledger_entry_id=l.ledger_entry_id ORDER BY seq DESC LIMIT 1) e ON true
      WHERE l.scenario_id=$1 AND l.payee_group_id=$2 AND e.state IN ('EARNED','RELEASED') AND l.releasable_at_sim<=$3
      ORDER BY l.earned_sim,l.ledger_entry_id`,[batch.scenario_id,payeeGroupId,batch.as_of_sim])).rows.map(r=>({id:r.id as string,netPaise:BigInt(r.net),seq:Number(r.seq)}));
    const pick=selectLots(lots,BigInt(batch.payout_limit_paise));
    if(result)result.oversized+=pick.oversized.length;
    if(!pick.taken.length)return 'NOTHING_RELEASABLE';
    if(pick.totalPaise<BigInt(batch.min_payout_paise))return 'ROLLED_OVER';
    const payoutId=randomUUID(),time=await simNow(tx,batch.scenario_id),taken=lots.filter(l=>pick.taken.includes(l.id));
    await tx.query(`INSERT INTO demo_payouts(id,batch_id,scenario_id,payee_group_id,account_token,gross_paise,amount_paise,flags)
      SELECT $1,$2,$3,$4,account_token,$5,$5,$6 FROM demo_payees WHERE scenario_id=$3 AND payee_group_id=$4`,
      [payoutId,batchId,batch.scenario_id,payeeGroupId,String(pick.totalPaise),pick.oversized.length?['OVERSIZED_LOT_SKIPPED']:[]]);
    await tx.query(`INSERT INTO demo_payout_items(payout_id,ledger_entry_id,scenario_id) SELECT $1,l::bigint,$2 FROM unnest($3::text[]) AS l`,[payoutId,batch.scenario_id,pick.taken]);
    await tx.query(`INSERT INTO demo_lot_events(ledger_entry_id,seq,scenario_id,state,payout_id,at_sim) SELECT x.l::bigint,x.s+1,$1,'IN_BATCH',$2,$3 FROM unnest($4::text[],$5::int[]) AS x(l,s)`,
      [batch.scenario_id,payoutId,time.sim,taken.map(l=>l.id),taken.map(l=>l.seq)]);
    await postJournals(tx,batch.scenario_id,[{spec:payoutBatched(payoutId,payeeGroupId,pick.totalPaise),payoutId}]);
    return 'PAID';
  });
}
/** Runs (or resumes) a batch over every payee with releasable lots. A payee that fails (e.g. lock timeout) leaves it PARTIAL. */
export async function runBatch(db:Database,batchId:string,options:{onPayeeError?:(error:unknown)=>void}={}):Promise<BatchSummary>{
  const batch=await loadBatch(db,batchId);
  const summary:BatchSummary={batchId,runDate:batch.run_date,runSeq:batch.run_seq,status:'COMPLETED',payouts:0,rolledOver:0,skippedReverify:0,oversizedLots:0,failedPayees:0};
  if(batch.status==='COMPLETED')return summary;
  const payees=(await db.query(`SELECT DISTINCT l.payee_group_id::text AS p FROM demo_earning_lots l
    JOIN LATERAL (SELECT state FROM demo_lot_events WHERE ledger_entry_id=l.ledger_entry_id ORDER BY seq DESC LIMIT 1) e ON true
    WHERE l.scenario_id=$1 AND e.state IN ('EARNED','RELEASED') AND l.releasable_at_sim<=$2 ORDER BY 1`,[batch.scenario_id,batch.as_of_sim])).rows.map(r=>r.p as string);
  const counter={oversized:0};
  for(const payee of payees){
    try{
      const outcome=await batchPayee(db,batchId,payee,counter);
      if(outcome==='PAID')summary.payouts++;
      else if(outcome==='ROLLED_OVER')summary.rolledOver++;
      else if(outcome==='REVERIFY_REQUIRED')summary.skippedReverify++;
    }catch(error){summary.failedPayees++;options.onPayeeError?.(error);}
  }
  summary.oversizedLots=counter.oversized;
  summary.status=summary.failedPayees?'PARTIAL':'COMPLETED';
  // Never downgrades: another runner may already have completed this batch.
  await db.query(`UPDATE demo_payout_batches SET status=$2,finished_at=CASE WHEN $2='COMPLETED' THEN now() END WHERE id=$1 AND status<>'COMPLETED' AND status IS DISTINCT FROM $2`,[batchId,summary.status]);
  return summary;
}
/** Worker entry: create today's scheduled run if missing, then run every batch of the scenario that is not complete. */
export async function runDueBatches(db:Database,scenarioId:string,options:{onPayeeError?:(error:unknown)=>void}={}):Promise<BatchSummary[]>{
  await ensureScheduledBatch(db,scenarioId);
  const open=(await db.query(`SELECT id::text AS id FROM demo_payout_batches WHERE scenario_id=$1 AND status<>'COMPLETED' ORDER BY created_at,run_seq`,[scenarioId])).rows.map(r=>r.id as string);
  const results:BatchSummary[]=[];
  for(const id of open)results.push(await runBatch(db,id,options));
  return results;
}
