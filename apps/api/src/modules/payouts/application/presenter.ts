import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
import {appendAudit} from '../../audit/application/audit.js';
import type {Actor} from '../../capture/application/capture.js';
import {withNewWorkLock} from '../../market/application/lock.js';
import {groupLabel} from '../../market/application/orders.js';
import {requireCase} from '../../review/application/workflow.js';
import {sandboxToken,type SandboxSuffix} from '../domain/config.js';
import type {PayoutRail} from '../domain/rail.js';
import {createPresenterBatch,runBatch} from './batch.js';
import {advanceClock,simNow} from './clock.js';
import {readLedgerConfig} from './earnings.js';
import {cancelPayout} from './settlement.js';
/**
 * Presenter controls and views (docs/23 §6.4). The caller has already checked requirePresenter. Every write is audited in the
 * same transaction: payee actions anchor to the payee's own case, scenario-wide ones (clock, config, batch) to the scenario's
 * first capture. Responses carry payee labels and token suffixes only, never case ids, tokens or rail references.
 */
const NAMESPACE='DEMO_ONLY' as const;
async function auditScenario(tx:Database,actor:Actor,action:string,facts:unknown){
  const anchor=(await tx.query('SELECT event_id::text AS id FROM captures WHERE scenario_id=$1 ORDER BY created_at,event_id LIMIT 1',[actor.scenarioId])).rows[0]?.id as string|undefined;
  if(!anchor)throw new WorkflowError('SCENARIO_EMPTY',409);
  await appendAudit(tx,actor,anchor,action,facts);
}
export async function presenterAdvanceClock(db:Database,actor:Actor,input:{expectedOffsetSeconds:number;advanceSeconds:number}){
  const moved=await advanceClock(db,actor.scenarioId,input,(tx,t)=>auditScenario(tx,actor,'payouts.clock.advanced',{fromOffsetSeconds:input.expectedOffsetSeconds,toOffsetSeconds:t.offsetSeconds}));
  return {namespace:NAMESPACE,offsetSeconds:moved.offsetSeconds,simulatedNow:moved.sim.toISOString()};
}
export async function presenterRunBatch(db:Database,actor:Actor,input:{requestId:string}){
  const batch=await createPresenterBatch(db,actor.scenarioId,{requestId:input.requestId,actorId:actor.id},(tx,batchId)=>auditScenario(tx,actor,'payouts.batch.run',{batchId,requestId:input.requestId}));
  const s=await runBatch(db,batch.batchId);
  return {namespace:NAMESPACE,batchId:batch.batchId,runDate:batch.runDate,runSeq:batch.runSeq,replayed:batch.replayed,status:s.status,
    payouts:s.payouts,rolledOver:s.rolledOver,skippedReverify:s.skippedReverify,oversizedLots:s.oversizedLots,failedPayees:s.failedPayees};
}
export type ConfigInput={holdbackDays:number;reserveBps:number;minPayoutPaise:string;payoutLimitPaise:string;backoffBaseSeconds?:number;idempotencyWindowSeconds?:number};
/** A new configuration version, effective from now in simulated time (docs/23 P4). Earlier lots and batches keep their snapshot. */
export async function presenterSetConfig(db:Database,actor:Actor,input:ConfigInput){
  const min=BigInt(input.minPayoutPaise),limit=BigInt(input.payoutLimitPaise);
  if(min<=0n||limit<min)throw new WorkflowError('VALIDATION_FAILED',422);
  return withNewWorkLock(db,actor.scenarioId,async tx=>{
    const time=await simNow(tx,actor.scenarioId),current=await readLedgerConfig(tx,actor.scenarioId,time.sim);
    const backoff=input.backoffBaseSeconds??current.backoffBaseSeconds,window=input.idempotencyWindowSeconds??current.idempotencyWindowSeconds;
    const version=(await tx.query(`INSERT INTO demo_ledger_config(scenario_id,version,holdback_days,reserve_bps,min_payout_paise,payout_limit_paise,backoff_base_seconds,idempotency_window_seconds,effective_from,created_by)
      SELECT $1,coalesce(max(version),0)+1,$2,$3,$4,$5,$6,$7,$8,$9 FROM demo_ledger_config WHERE scenario_id=$1 RETURNING version`,
      [actor.scenarioId,input.holdbackDays,input.reserveBps,String(min),String(limit),backoff,window,time.sim,actor.id])).rows[0].version as number;
    const config={version,holdbackDays:input.holdbackDays,reserveBps:input.reserveBps,minPayoutPaise:String(min),payoutLimitPaise:String(limit),backoffBaseSeconds:backoff,idempotencyWindowSeconds:window};
    await auditScenario(tx,actor,'payouts.config.changed',config);
    return {namespace:NAMESPACE,...config,effectiveFrom:time.sim.toISOString()};
  });
}
/** The presenter's re-verification stand-in: a new sandbox suffix for one payee, which also clears reverify_required. */
export async function presenterSetSuffix(db:Database,actor:Actor,code:string,suffix:SandboxSuffix){
  return db.transaction(async tx=>{
    const payees=(await tx.query('SELECT payee_group_id::text AS id FROM demo_payees WHERE scenario_id=$1',[actor.scenarioId])).rows.map(r=>r.id as string);
    const payee=payees.find(id=>groupLabel(id)===`Group ${code}`);
    if(!payee)throw new WorkflowError('NOT_FOUND',404);
    await tx.query('SELECT 1 FROM demo_payee_state WHERE scenario_id=$1 AND payee_group_id=$2 FOR UPDATE',[actor.scenarioId,payee]);
    await tx.query('UPDATE demo_payees SET account_token=$3 WHERE scenario_id=$1 AND payee_group_id=$2',[actor.scenarioId,payee,sandboxToken(payee,suffix)]);
    await tx.query('UPDATE demo_payee_state SET reverify_required=false WHERE scenario_id=$1 AND payee_group_id=$2',[actor.scenarioId,payee]);
    await appendAudit(tx,actor,payee,'payouts.payee.sandbox',{label:groupLabel(payee),suffix});
    return {namespace:NAMESPACE,label:groupLabel(payee),suffix};
  });
}
export async function presenterCancel(db:Database,actor:Actor,payoutId:string,input:{requestId:string;reason:string},rail:PayoutRail){
  if(!(await db.query('SELECT 1 FROM demo_payouts WHERE id=$1 AND scenario_id=$2',[payoutId,actor.scenarioId])).rows.length)throw new WorkflowError('NOT_FOUND',404);
  const result=await cancelPayout(db,payoutId,{rail,audit:(tx,payee)=>appendAudit(tx,actor,payee,'payouts.payout.cancelled',{payoutId,requestId:input.requestId,reason:input.reason})});
  return {namespace:NAMESPACE,payoutId,...result};
}
const balanceSql=`(SELECT coalesce(sum(CASE side WHEN 'CR' THEN amount_paise ELSE -amount_paise END),0) FROM demo_journal_lines j WHERE j.scenario_id=p.scenario_id AND j.account='payee_payable' AND j.payee_group_id=p.payee_group_id)`;
const latest=`JOIN LATERAL (SELECT state FROM demo_lot_events WHERE ledger_entry_id=l.ledger_entry_id ORDER BY seq DESC LIMIT 1) ev ON true`;
/** The presenter's payout panel: every payee by label (seeded groups included), recent batches and payouts, clock and config. */
export async function presenterPanel(db:Database,actor:Actor){
  const scenario=actor.scenarioId;
  const time=await db.transaction(tx=>simNow(tx,scenario)),config=await db.transaction(tx=>readLedgerConfig(tx,scenario,time.sim));
  const payees=(await db.query(`SELECT p.payee_group_id::text AS id,right(p.account_token,2) AS suffix,s.reverify_required,${balanceSql}::text AS payable,
      (SELECT coalesce(sum(l.net_paise),0) FROM demo_earning_lots l ${latest} WHERE l.scenario_id=p.scenario_id AND l.payee_group_id=p.payee_group_id AND ev.state IN ('EARNED','RELEASED') AND l.releasable_at_sim>$2)::text AS held,
      (SELECT coalesce(sum(amount_paise),0) FROM demo_payouts WHERE scenario_id=p.scenario_id AND payee_group_id=p.payee_group_id AND state='SETTLED')::text AS paid
    FROM demo_payees p JOIN demo_payee_state s USING (scenario_id,payee_group_id) WHERE p.scenario_id=$1`,[scenario,time.sim])).rows;
  const payouts=(await db.query(`SELECT id::text AS id,payee_group_id::text AS payee,state,amount_paise::text AS amount,attempts,flags,non_payment_confirmed AS npc,first_request_sim,created_at
    FROM demo_payouts WHERE scenario_id=$1 ORDER BY created_at DESC,id LIMIT 50`,[scenario])).rows;
  const batches=(await db.query(`SELECT b.run_date::text AS run_date,b.run_seq,b.status,b.created_by,b.created_at,(SELECT count(*)::int FROM demo_payouts p WHERE p.batch_id=b.id) AS payouts
    FROM demo_payout_batches b WHERE b.scenario_id=$1 ORDER BY b.created_at DESC LIMIT 20`,[scenario])).rows;
  const cancellable=(p:any)=>['NEEDS_REVIEW','UNRESOLVED'].includes(p.state)&&(p.npc||p.first_request_sim===null||time.sim.getTime()-new Date(p.first_request_sim).getTime()>=config.idempotencyWindowSeconds*1000);
  return {namespace:NAMESPACE,clock:{offsetSeconds:time.offsetSeconds,simulatedNow:time.sim.toISOString()},
    config:{version:config.version,holdbackDays:config.holdbackDays,reserveBps:config.reserveBps,minPayoutPaise:String(config.minPayoutPaise),payoutLimitPaise:String(config.payoutLimitPaise),
      backoffBaseSeconds:config.backoffBaseSeconds,idempotencyWindowSeconds:config.idempotencyWindowSeconds},
    payees:payees.map(p=>({label:groupLabel(p.id),suffix:p.suffix as string,reverifyRequired:p.reverify_required as boolean,payablePaise:p.payable as string,heldPaise:p.held as string,paidPaise:p.paid as string}))
      .sort((a,b)=>a.label<b.label?-1:a.label>b.label?1:0),
    batches:batches.map(b=>({runDate:b.run_date,runSeq:b.run_seq,status:b.status,createdBy:b.created_by==='worker'?'worker':'presenter',createdAt:new Date(b.created_at).toISOString(),payouts:b.payouts})),
    payouts:payouts.map(p=>({id:p.id,payee:groupLabel(p.payee),state:p.state,amountPaise:p.amount,attempts:p.attempts,flags:p.flags,cancellable:cancellable(p),createdAt:new Date(p.created_at).toISOString()}))};
}
/**
 * The earnings statement of one case (docs/23 P12): only for the agent who owns it; verifiers and others are refused.
 * Per credit: gross, commission, net and reserve share, and where the money is (held, releasable, in a payout, paid).
 */
export async function caseStatement(db:Database,actor:Actor,caseId:string){
  if(actor.role!=='agent')throw new WorkflowError('FORBIDDEN',403);
  await requireCase(db,actor,caseId);
  const time=await db.transaction(tx=>simNow(tx,actor.scenarioId));
  const rows=(await db.query(`SELECT e.credit_id,e.created_at,e.gross_paise::text AS gross,e.commission_paise::text AS commission,e.net_paise::text AS net,
      coalesce(f.total_paise,0)::text AS reserve,l.releasable_at_sim,ev.state
    FROM demo_ledger_entries e LEFT JOIN demo_journal_entries f ON f.idempotency_key='FUND:'||e.id LEFT JOIN demo_earning_lots l ON l.ledger_entry_id=e.id
    LEFT JOIN LATERAL (SELECT state FROM demo_lot_events WHERE ledger_entry_id=e.id ORDER BY seq DESC LIMIT 1) ev ON true
    WHERE e.scenario_id=$1 AND e.payee_group_id=$2 ORDER BY e.id`,[actor.scenarioId,caseId])).rows;
  const where=(r:any)=>!r.state?'NO_NET':r.state==='IN_BATCH'?'IN_PAYOUT':r.state==='PAID'?'PAID':new Date(r.releasable_at_sim).getTime()<=time.sim.getTime()?'RELEASABLE':'HELD';
  const payouts=(await db.query(`SELECT state,amount_paise::text AS amount,created_at FROM demo_payouts WHERE scenario_id=$1 AND payee_group_id=$2 ORDER BY created_at,id`,[actor.scenarioId,caseId])).rows;
  const balance=(await db.query(`SELECT coalesce(sum(CASE side WHEN 'CR' THEN amount_paise ELSE -amount_paise END),0)::text AS b FROM demo_journal_lines WHERE scenario_id=$1 AND account='payee_payable' AND payee_group_id=$2`,[actor.scenarioId,caseId])).rows[0].b as string;
  const sum=(key:string,list:any[])=>String(list.reduce((n,r)=>n+BigInt(r[key]),0n));
  return {namespace:NAMESPACE,label:groupLabel(caseId),simulatedNow:time.sim.toISOString(),
    lines:rows.map(r=>({creditId:r.credit_id as string,earnedAt:new Date(r.created_at).toISOString(),grossPaise:r.gross,commissionPaise:r.commission,netPaise:r.net,reserveSharePaise:r.reserve,
      state:where(r),releasableAt:r.releasable_at_sim?new Date(r.releasable_at_sim).toISOString():null})),
    payouts:payouts.map(p=>({state:p.state as string,amountPaise:p.amount as string,createdAt:new Date(p.created_at).toISOString()})),
    payableBalancePaise:balance,
    totals:{grossPaise:sum('gross',rows),commissionPaise:sum('commission',rows),netPaise:sum('net',rows),reserveSharePaise:sum('reserve',rows),paidPaise:sum('amount',payouts.filter(p=>p.state==='SETTLED'))}};
}
