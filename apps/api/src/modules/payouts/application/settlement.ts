import type {Database} from '../../../kernel/database.js';
import type {Logger} from '../../../kernel/logger.js';
import {groupLabel} from '../../market/application/orders.js';
import {WorkflowError} from '../../../kernel/errors.js';
import {backoffSeconds,withDeadline} from '../../../kernel/retry.js';
import {payoutReversed,payoutSettled} from '../domain/postings.js';
import type {LookupOutcome,PayoutRail,SendOutcome} from '../domain/rail.js';
import {simNow} from './clock.js';
import {readLedgerConfig} from './earnings.js';
import {postJournals} from './journal.js';
/**
 * Send, resolve, settle, return and cancel (docs/23 §6.3, P10). The rules that matter:
 *   - no lock is held across a rail call: a short transaction claims (attempt opened, real-time lease set), the call happens
 *     outside, and a second transaction records the outcome only if the claim is still current (fenced by the lease value);
 *   - an unknown outcome is never retried blind: the payout is resolved by key first, and resent with the same key and token
 *     snapshot only on NOT_FOUND inside the idempotency window, at most six attempts in all;
 *   - only settlePayout posts E13 and marks lots PAID; returns and cancels post E14 and release the lots;
 *   - nothing is cancelled unless the rail confirms it was not paid (voidKey), and only once confirmation is possible.
 * Every transaction here takes the payee lock, then the payout row (lock order steps 5, 6), with a 3 s lock timeout.
 */
export const MAX_ATTEMPTS=6,BACKOFF_CAP_SECONDS=3600,UNRESOLVED_AFTER_SECONDS=86400;
export type SettlementOptions={rail:PayoutRail;deadlineMs?:number;leaseSeconds?:number;random?:()=>number;limit?:number;onError?:(error:unknown)=>void;log?:Logger};
type Transition={payoutId:string;payee:string;from:string;to:string;attempt:number;outcome:string};
/** Logs a state change by payout id and payee label, never the token or the payee (case) id (docs/23 §9). */
const logTransition=(log:Logger|undefined,t:Transition|undefined)=>{if(log&&t&&t.from!==t.to)log.info({payoutId:t.payoutId,payee:groupLabel(t.payee),from:t.from,to:t.to,attempt:t.attempt,outcome:t.outcome},'Payout state changed');};
export type SendClaim={payoutId:string;scenarioId:string;attemptNo:number;lease:string;accountToken:string;amountPaise:bigint};
export type ReconcileClaim={payoutId:string;scenarioId:string;lease:string};
type Unknown={kind:'UNKNOWN'};
type Payout={id:string;scenario_id:string;payee_group_id:string;account_token:string;amount_paise:string;state:string;attempts:number;first_request_sim:Date|null;lease:string|null;npc:boolean;flags:string[]};
const deadline=(o:{deadlineMs?:number})=>o.deadlineMs??10_000;
const leaseFor=(o:{deadlineMs?:number;leaseSeconds?:number})=>o.leaseSeconds??Math.ceil(deadline(o)/1000)+15;

/** Lock order (5) payee state, then (6) the payout. Returns undefined for an unknown payout. */
async function lockPayout(tx:Database,payoutId:string):Promise<Payout|undefined>{
  const head=(await tx.query('SELECT scenario_id,payee_group_id FROM demo_payouts WHERE id=$1',[payoutId])).rows[0];
  if(!head)return undefined;
  await tx.query(`SET LOCAL lock_timeout = '3s'`);
  await tx.query('SELECT 1 FROM demo_payee_state WHERE scenario_id=$1 AND payee_group_id=$2 FOR UPDATE',[head.scenario_id,head.payee_group_id]);
  return (await tx.query(`SELECT id::text AS id,scenario_id,payee_group_id::text AS payee_group_id,account_token,amount_paise::text AS amount_paise,state,attempts,first_request_sim,
    lease_until_real::text AS lease,non_payment_confirmed AS npc,flags FROM demo_payouts WHERE id=$1 FOR UPDATE`,[payoutId])).rows[0] as Payout;
}
const holdsLease=(p:Payout,lease:string)=>p.lease!==null&&p.lease===lease;
const closeAttempt=(tx:Database,p:Payout,cls:string,railRef:string|null=null)=>tx.query(
  `UPDATE demo_payout_attempts SET outcome_at=clock_timestamp(),class=$2,rail_ref=$3 WHERE payout_id=$1 AND outcome_at IS NULL`,[p.id,cls,railRef]);
async function openAttempt(tx:Database,p:Payout,sim:Date,leaseSeconds:number):Promise<SendClaim>{
  const n=p.attempts+1;
  await tx.query('INSERT INTO demo_payout_attempts(payout_id,attempt_no,scenario_id,requested_at_sim) VALUES ($1,$2,$3,$4)',[p.id,n,p.scenario_id,sim]);
  const lease=(await tx.query(`UPDATE demo_payouts SET state='IN_SETTLEMENT',attempts=$2,next_attempt_at_sim=NULL,first_request_sim=coalesce(first_request_sim,$3),
    lease_until_real=clock_timestamp()+make_interval(secs=>$4) WHERE id=$1 RETURNING lease_until_real::text AS lease`,[p.id,n,sim,leaseSeconds])).rows[0].lease as string;
  return {payoutId:p.id,scenarioId:p.scenario_id,attemptNo:n,lease,accountToken:p.account_token,amountPaise:BigInt(p.amount_paise)};
}
async function setState(tx:Database,p:Payout,state:string,o:{next?:Date|null;railRef?:string|null}={}){
  await tx.query(`UPDATE demo_payouts SET state=$2,lease_until_real=NULL,next_attempt_at_sim=$3,rail_ref=coalesce(rail_ref,$4) WHERE id=$1`,[p.id,state,o.next??null,o.railRef??null]);
  p.state=state;
}
async function needsReview(tx:Database,p:Payout,o:{confirmedUnpaid?:boolean;flag?:string;reverify?:boolean}){
  await tx.query(`UPDATE demo_payouts SET state='NEEDS_REVIEW',lease_until_real=NULL,next_attempt_at_sim=NULL,non_payment_confirmed=non_payment_confirmed OR $2,
    flags=CASE WHEN $3::text IS NULL OR $3=ANY(flags) THEN flags ELSE array_append(flags,$3) END WHERE id=$1`,[p.id,o.confirmedUnpaid??false,o.flag??null]);
  p.state='NEEDS_REVIEW';
  if(o.reverify)await tx.query('UPDATE demo_payee_state SET reverify_required=true WHERE scenario_id=$1 AND payee_group_id=$2',[p.scenario_id,p.payee_group_id]);
}
/** Appends one lot event per active item of the payout (the payout row is already in the state the event requires). */
const lotEvents=(tx:Database,p:Payout,state:'PAID'|'RELEASED',sim:Date)=>tx.query(`INSERT INTO demo_lot_events(ledger_entry_id,seq,scenario_id,state,payout_id,at_sim)
  SELECT i.ledger_entry_id,(SELECT max(seq)+1 FROM demo_lot_events e WHERE e.ledger_entry_id=i.ledger_entry_id),$2,$3,$1,$4 FROM demo_payout_items i WHERE i.payout_id=$1 AND i.active`,[p.id,p.scenario_id,state,sim]);
/** The only path for E13 and PAID lots (docs/23 §6.3). */
async function settlePayout(tx:Database,p:Payout,sim:Date,railRef:string|null){
  await setState(tx,p,'SETTLED',{railRef});
  await postJournals(tx,p.scenario_id,[{spec:payoutSettled(p.id,BigInt(p.amount_paise)),payoutId:p.id}]);
  await lotEvents(tx,p,'PAID',sim);
}
/** E14, items released, lots RELEASED: for a RETURNED or CANCELLED payout (the state is set first). */
async function reversePayout(tx:Database,p:Payout,sim:Date){
  await postJournals(tx,p.scenario_id,[{spec:payoutReversed(p.id,p.payee_group_id,BigInt(p.amount_paise)),payoutId:p.id}]);
  await lotEvents(tx,p,'RELEASED',sim);
  await tx.query('UPDATE demo_payout_items SET active=false WHERE payout_id=$1 AND active',[p.id]);
}
/** What the rail reports for a key, applied to the payout. */
async function applyFound(tx:Database,p:Payout,found:Extract<LookupOutcome,{kind:'FOUND'}>,sim:Date){
  if(found.status==='REJECTED'||found.status==='VOIDED'){await needsReview(tx,p,{confirmedUnpaid:true,reverify:found.status==='REJECTED'});return;}
  if(p.npc){await needsReview(tx,p,{flag:'PROCESSED_AFTER_CONFIRMATION'});return;}   // the rail paid after we were told it had not
  if(found.status==='PROCESSING'){if(p.state!=='SENT')await setState(tx,p,'SENT',{next:sim,railRef:found.railRef});else await setState(tx,p,'SENT',{next:sim});return;}
  if(found.status==='SETTLED'){
    if(found.amountPaise!==BigInt(p.amount_paise)){await needsReview(tx,p,{flag:'AMOUNT_MISMATCH'});return;}
    await settlePayout(tx,p,sim,found.railRef);return;
  }
  // RETURNED: it was sent, then came back.
  if(p.state!=='SENT')await setState(tx,p,'SENT',{railRef:found.railRef});
  await setState(tx,p,'RETURNED');
  await reversePayout(tx,p,sim);
  await tx.query('UPDATE demo_payee_state SET reverify_required=true WHERE scenario_id=$1 AND payee_group_id=$2',[p.scenario_id,p.payee_group_id]);
}

/** Phase 1 of a send: claim a due PENDING/RETRY payout, open the attempt, set the lease. Null if it is not (or no longer) due. */
export async function beginSend(db:Database,payoutId:string,o:{leaseSeconds?:number;deadlineMs?:number}={}):Promise<SendClaim|null>{
  return db.transaction(async tx=>{
    const p=await lockPayout(tx,payoutId);
    if(!p||!['PENDING','RETRY'].includes(p.state)||p.attempts>=MAX_ATTEMPTS)return null;
    const time=await simNow(tx,p.scenario_id);
    const due=(await tx.query('SELECT next_attempt_at_sim IS NULL OR next_attempt_at_sim<=$2 AS due FROM demo_payouts WHERE id=$1',[payoutId,time.sim])).rows[0].due;
    if(!due)return null;
    return openAttempt(tx,p,time.sim,leaseFor(o));
  });
}
/** Phase 3 of a send: record the rail's answer, if the claim still holds. */
export async function finishSend(db:Database,claim:SendClaim,outcome:SendOutcome|Unknown,o:{random?:()=>number;log?:Logger}={}):Promise<string>{
  let change:Transition|undefined;
  const state=await db.transaction(async tx=>{
    const p=await lockPayout(tx,claim.payoutId);
    if(!p||p.state!=='IN_SETTLEMENT'||!holdsLease(p,claim.lease)||p.attempts!==claim.attemptNo)return 'STALE';
    const time=await simNow(tx,p.scenario_id),config=await readLedgerConfig(tx,p.scenario_id,time.sim);
    switch(outcome.kind){
      case 'ACCEPTED':await closeAttempt(tx,p,'ACCEPTED',outcome.railRef);await setState(tx,p,'SENT',{next:time.sim,railRef:outcome.railRef});break;
      case 'SETTLED':
        await closeAttempt(tx,p,'SETTLED',outcome.railRef);
        await applyFound(tx,p,{kind:'FOUND',status:'SETTLED',amountPaise:outcome.amountPaise,railRef:outcome.railRef},time.sim);break;
      case 'TRANSIENT':
        await closeAttempt(tx,p,'TRANSIENT');
        if(p.attempts>=MAX_ATTEMPTS)await needsReview(tx,p,{flag:'ATTEMPTS_EXHAUSTED'});
        else await setState(tx,p,'RETRY',{next:new Date(time.sim.getTime()+backoffSeconds(p.attempts,config.backoffBaseSeconds,BACKOFF_CAP_SECONDS,o.random)*1000)});
        break;
      case 'REJECTED':await closeAttempt(tx,p,'REJECTED');await needsReview(tx,p,{confirmedUnpaid:true,reverify:outcome.code!=='KEY_VOIDED'});break;
      case 'CONFLICT':await closeAttempt(tx,p,'CONFLICT');await needsReview(tx,p,{flag:'RAIL_KEY_CONFLICT'});break;
      // The attempt stays open until resolved by key, after a backoff that gives the rail time to register the request.
      case 'UNKNOWN':await setState(tx,p,'INDETERMINATE',{next:new Date(time.sim.getTime()+backoffSeconds(p.attempts,config.backoffBaseSeconds,BACKOFF_CAP_SECONDS,o.random)*1000)});break;
    }
    change={payoutId:p.id,payee:p.payee_group_id,from:'IN_SETTLEMENT',to:p.state,attempt:claim.attemptNo,outcome:outcome.kind};
    return p.state;
  });
  logTransition(o.log,change);
  return state;
}
/** The rail call of a send, bounded by the deadline. Any failure is an unknown outcome, never a confirmed failure. */
async function callSend(rail:PayoutRail,claim:SendClaim,o:SettlementOptions):Promise<SendOutcome|Unknown>{
  try{return await withDeadline(rail.send({scenarioId:claim.scenarioId,key:claim.payoutId,accountToken:claim.accountToken,amountPaise:claim.amountPaise}),deadline(o),'RAIL_TIMEOUT');}
  catch(error){o.onError?.(error);return {kind:'UNKNOWN'};}
}
export async function sendPayout(db:Database,payoutId:string,o:SettlementOptions):Promise<string>{
  const claim=await beginSend(db,payoutId,o);
  if(!claim)return 'SKIPPED';
  return finishSend(db,claim,await callSend(o.rail,claim,o),o);
}

/**
 * Phase 1 of a resolve or poll: an IN_SETTLEMENT payout whose real-time lease expired (its sender stalled or died), or an
 * INDETERMINATE, UNRESOLVED or SENT payout that is due. The resolver takes the lease itself, so two resolvers cannot overlap.
 */
export async function beginReconcile(db:Database,payoutId:string,o:{leaseSeconds?:number;deadlineMs?:number}={}):Promise<ReconcileClaim|null>{
  return db.transaction(async tx=>{
    const p=await lockPayout(tx,payoutId);
    if(!p)return null;
    const time=await simNow(tx,p.scenario_id);
    const r=(await tx.query(`SELECT (lease_until_real IS NULL OR lease_until_real<clock_timestamp()) AS free,(next_attempt_at_sim IS NULL OR next_attempt_at_sim<=$2) AS due FROM demo_payouts WHERE id=$1`,[payoutId,time.sim])).rows[0];
    const eligible=p.state==='IN_SETTLEMENT'?p.lease!==null&&r.free:['INDETERMINATE','UNRESOLVED','SENT'].includes(p.state)&&r.free&&r.due;
    if(!eligible)return null;
    const lease=(await tx.query(`UPDATE demo_payouts SET state=CASE WHEN state='IN_SETTLEMENT' THEN 'INDETERMINATE' ELSE state END,
      lease_until_real=clock_timestamp()+make_interval(secs=>$2) WHERE id=$1 RETURNING lease_until_real::text AS lease`,[payoutId,leaseFor(o)])).rows[0].lease as string;
    return {payoutId,scenarioId:p.scenario_id,lease};
  });
}
export type ReconcileResult={kind:'DONE';state:string}|{kind:'RESEND';claim:SendClaim}|{kind:'STALE'};
/** Phase 3 of a resolve: apply what getByKey said (or that it could not say). NOT_FOUND may lead to a resend claim. */
export async function finishReconcile(db:Database,payoutId:string,claim:ReconcileClaim,lookup:LookupOutcome|Unknown,o:{leaseSeconds?:number;deadlineMs?:number;random?:()=>number;log?:Logger}={}):Promise<ReconcileResult>{
  let change:Transition|undefined;
  const result=await db.transaction(async tx=>{
    const p=await lockPayout(tx,payoutId);
    if(!p||!holdsLease(p,claim.lease))return {kind:'STALE'} as ReconcileResult;
    const from=p.state,outcome=lookup.kind==='FOUND'?`FOUND_${lookup.status}`:lookup.kind;
    const done=(r:ReconcileResult):ReconcileResult=>{change={payoutId:p.id,payee:p.payee_group_id,from,to:p.state,attempt:p.attempts,outcome};return r;};
    const time=await simNow(tx,p.scenario_id),config=await readLedgerConfig(tx,p.scenario_id,time.sim);
    const since=p.first_request_sim?(time.sim.getTime()-new Date(p.first_request_sim).getTime())/1000:0;
    if(lookup.kind==='FOUND'){
      await closeAttempt(tx,p,lookup.status==='REJECTED'||lookup.status==='VOIDED'?'REJECTED':'RESOLVED_FOUND',lookup.railRef);
      await applyFound(tx,p,lookup,time.sim);
      return done({kind:'DONE',state:p.state});
    }
    const later=new Date(time.sim.getTime()+backoffSeconds(Math.max(1,p.attempts),config.backoffBaseSeconds,BACKOFF_CAP_SECONDS,o.random)*1000);
    if(lookup.kind==='UNKNOWN'){
      // A fresh query that could not answer: after 24 simulated hours the payout is UNRESOLVED, and still polled.
      if(p.state==='INDETERMINATE'&&since>=UNRESOLVED_AFTER_SECONDS)await setState(tx,p,'UNRESOLVED',{next:new Date(time.sim.getTime()+BACKOFF_CAP_SECONDS*1000)});
      else await setState(tx,p,p.state,{next:p.state==='UNRESOLVED'?new Date(time.sim.getTime()+BACKOFF_CAP_SECONDS*1000):later});
      return done({kind:'DONE',state:p.state});
    }
    if(p.state==='SENT'){await needsReview(tx,p,{flag:'SENT_NOT_FOUND'});return done({kind:'DONE',state:p.state});}
    await closeAttempt(tx,p,'RESOLVED_ABSENT');
    if(since>=config.idempotencyWindowSeconds){await needsReview(tx,p,{confirmedUnpaid:true});return done({kind:'DONE',state:p.state});}
    if(p.state==='UNRESOLVED'){await setState(tx,p,'UNRESOLVED',{next:later});return done({kind:'DONE',state:p.state});}
    if(p.attempts>=MAX_ATTEMPTS){await needsReview(tx,p,{flag:'ATTEMPTS_EXHAUSTED'});return done({kind:'DONE',state:p.state});}
    const resend=await openAttempt(tx,p,time.sim,leaseFor(o));p.state='IN_SETTLEMENT';
    return done({kind:'RESEND',claim:resend});
  });
  logTransition(o.log,change);
  return result;
}
export async function reconcilePayout(db:Database,payoutId:string,o:SettlementOptions):Promise<string>{
  const claim=await beginReconcile(db,payoutId,o);
  if(!claim)return 'SKIPPED';
  let lookup:LookupOutcome|Unknown;
  try{lookup=await withDeadline(o.rail.getByKey({scenarioId:claim.scenarioId,key:payoutId}),deadline(o),'RAIL_TIMEOUT');}
  catch(error){o.onError?.(error);lookup={kind:'UNKNOWN'};}
  const result=await finishReconcile(db,payoutId,claim,lookup,o);
  if(result.kind==='RESEND')return finishSend(db,result.claim,await callSend(o.rail,result.claim,o),o);
  return result.kind==='DONE'?result.state:'STALE';
}

/**
 * Presenter cancel (docs/23 §6.3): only NEEDS_REVIEW or UNRESOLVED, and only once non-payment can be confirmed (already
 * confirmed, or the idempotency window has passed). voidKey runs outside any transaction; if the rail says the money already
 * went, the payout follows the rail instead and the cancel is refused.
 */
export async function cancelPayout(db:Database,payoutId:string,o:{rail:PayoutRail;deadlineMs?:number;audit?:(tx:Database,payee:string)=>Promise<unknown>}):Promise<{state:'CANCELLED';replayed:boolean}>{
  const p=(await db.query(`SELECT scenario_id,state,non_payment_confirmed AS npc,first_request_sim FROM demo_payouts WHERE id=$1`,[payoutId])).rows[0];
  if(!p)throw new WorkflowError('NOT_FOUND',404);
  if(p.state==='CANCELLED')return {state:'CANCELLED',replayed:true};
  if(!['NEEDS_REVIEW','UNRESOLVED'].includes(p.state))throw new WorkflowError('PAYOUT_NOT_CANCELLABLE',409);
  const time=await db.transaction(tx=>simNow(tx,p.scenario_id)),config=await db.transaction(tx=>readLedgerConfig(tx,p.scenario_id,time.sim));
  const windowPassed=p.first_request_sim===null||time.sim.getTime()-new Date(p.first_request_sim).getTime()>=config.idempotencyWindowSeconds*1000;
  if(!p.npc&&!windowPassed)throw new WorkflowError('PAYOUT_MAY_BE_PAID',409);
  const ask=async<T>(work:Promise<T>)=>{try{return await withDeadline(work,deadline(o),'RAIL_TIMEOUT');}catch{throw new WorkflowError('RAIL_UNAVAILABLE',503);}};
  const voided=await ask(o.rail.voidKey({scenarioId:p.scenario_id,key:payoutId}));
  const found=voided==='ALREADY_PROCESSED'?await ask(o.rail.getByKey({scenarioId:p.scenario_id,key:payoutId})):null;
  const outcome=await db.transaction(async tx=>{
    const row=await lockPayout(tx,payoutId);
    if(!row)throw new WorkflowError('NOT_FOUND',404);
    if(row.state==='CANCELLED')return 'REPLAYED';
    if(!['NEEDS_REVIEW','UNRESOLVED'].includes(row.state))throw new WorkflowError('PAYOUT_NOT_CANCELLABLE',409);
    const now=await simNow(tx,row.scenario_id);
    if(voided==='VOIDED'){
      await tx.query(`UPDATE demo_payouts SET non_payment_confirmed=true,state='CANCELLED',lease_until_real=NULL,next_attempt_at_sim=NULL WHERE id=$1`,[payoutId]);
      row.state='CANCELLED';
      await closeAttempt(tx,row,'RESOLVED_ABSENT');
      await reversePayout(tx,row,now.sim);
      await o.audit?.(tx,row.payee_group_id);
      return 'CANCELLED';
    }
    if(found?.kind==='FOUND')await applyFound(tx,row,found,now.sim);
    return 'PROCESSED';
  });
  if(outcome==='PROCESSED')throw new WorkflowError('PAYOUT_PROCESSED',409);
  return {state:'CANCELLED',replayed:outcome==='REPLAYED'};
}

/**
 * One worker pass for a scenario: tick the sandbox rail, send what is due, then resolve and poll. Ids are picked with SKIP
 * LOCKED in a short transaction; each payout is then claimed under its own locks and re-checked, so concurrent workers never
 * send one payout twice. Counted, capped, and isolated: one payout's failure does not stop the others.
 */
export async function runSettlementCycle(db:Database,scenarioId:string,o:SettlementOptions):Promise<{sent:number;reconciled:number;failed:number}>{
  const limit=o.limit??50,result={sent:0,reconciled:0,failed:0};
  await o.rail.tick?.(scenarioId);
  const pick=(sql:string)=>db.transaction(async tx=>{
    const time=await simNow(tx,scenarioId);
    return (await tx.query(sql,[scenarioId,time.sim,limit])).rows.map(r=>r.id as string);
  });
  const sendable=await pick(`SELECT id::text AS id FROM demo_payouts WHERE scenario_id=$1 AND state IN ('PENDING','RETRY') AND (next_attempt_at_sim IS NULL OR next_attempt_at_sim<=$2)
    ORDER BY created_at,id LIMIT $3 FOR UPDATE SKIP LOCKED`);
  for(const id of sendable){
    try{if(await sendPayout(db,id,o)!=='SKIPPED')result.sent++;}catch(error){result.failed++;o.onError?.(error);}
  }
  const reconcilable=await pick(`SELECT id::text AS id FROM demo_payouts WHERE scenario_id=$1 AND (lease_until_real IS NULL OR lease_until_real<clock_timestamp())
    AND ((state='IN_SETTLEMENT' AND lease_until_real IS NOT NULL) OR (state IN ('INDETERMINATE','UNRESOLVED','SENT') AND (next_attempt_at_sim IS NULL OR next_attempt_at_sim<=$2)))
    ORDER BY created_at,id LIMIT $3 FOR UPDATE SKIP LOCKED`);
  for(const id of reconcilable){
    try{if(await reconcilePayout(db,id,o)!=='SKIPPED')result.reconciled++;}catch(error){result.failed++;o.onError?.(error);}
  }
  return result;
}
