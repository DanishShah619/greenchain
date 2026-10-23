import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {WorkflowError,safeErrorFields} from '../../../kernel/errors.js';
import {appendAudit} from '../../audit/application/audit.js';
import type {Actor} from '../../capture/application/capture.js';
import {ledgerLine} from '../domain/money.js';
import {postEarnings} from '../../payouts/application/earnings.js';
import {withScenarioLock} from './lock.js';
import {DEFAULT_MARKET,orderAnchor,orderView,ownedOrder,reapExpired,requireBuyer,snapshotHash,systemActor,type MarketConfig,type OrderView} from './orders.js';
/**
 * Payments (docs/22 §6.1): starting an attempt, and applying signed provider events. The rule that matters most:
 * an event is recorded in the SAME transaction that applies it, as the last write, so a rolled-back apply leaves no trace and
 * the provider's redelivery is applied from scratch.
 */
export type PaymentConfig={
  provider:string;
  /** Current and previous webhook secrets (rotation). Never logged. */
  secrets:string[];
  toleranceSeconds:number;
  /** A PENDING confirmation extends the reservation to now + this, capped at allocated_at + maxHoldSeconds. */
  pendingExtensionSeconds:number;maxHoldSeconds:number;
  maxBodyBytes:number;
  /** Failed applies of one event before it is parked as a dead letter (the provider then stops retrying). */
  maxEventFailures:number;
};
export const DEFAULT_PAYMENTS:Omit<PaymentConfig,'secrets'>={provider:'simulator',toleranceSeconds:300,pendingExtensionSeconds:900,maxHoldSeconds:1800,maxBodyBytes:16384,maxEventFailures:8};
export const EVENT_TYPES=['payment.pending','payment.succeeded','payment.failed','payment.cancelled'] as const;
export type ProviderEvent={id:string;type:typeof EVENT_TYPES[number];providerRef:string;amountPaise:bigint;currency:string};
export type PaymentOutcome='FULFILLED'|'REVALIDATED_FULFILLED'|'REFUND_LATE_UNFILLABLE'|'REFUND_DUPLICATE_ATTEMPT'|'AMOUNT_MISMATCH'|'ATTEMPT_UPDATED'|'IGNORED_SAME_ATTEMPT'|'IGNORED_TERMINAL';
export type WebhookResult={status:200|400|401|404|409|413|503;code?:string;outcome?:PaymentOutcome;replayed?:boolean;
  /** The provider's event id, once the signature is verified. For logs only; never in responses. */eventId?:string;
  /** The event is a dead letter: received, not applied, waiting for an operator retry. */parked?:boolean;
  /** This delivery is the one that parked it. */justParked?:boolean;
  /** Why the apply failed: error class and machine code (e.g. a SQLSTATE) only. For logs only; never in responses. */
  error?:{errorName:string;errorCode?:string};
  /** The failure could not be recorded either (usually the database itself is down); the provider's retry will. */
  failureNotRecorded?:boolean};
export type RawWebhook={body:Buffer;signature?:string;timestamp?:string};
const sha256=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const money=(value:unknown)=>BigInt(String(value));
/** The signature a provider (or the simulator) sends: HMAC-SHA256 over "timestamp.rawBody", hex. */
export const signWebhook=(secret:string,timestamp:string,body:Buffer|string)=>createHmac('sha256',secret).update(`${timestamp}.`).update(body).digest('hex');
/** Pure check of size, timestamp window and signature, then strict parsing. No database access, so nothing can be written on failure. */
export function verifyWebhook(raw:RawWebhook,config:PaymentConfig,nowMs=Date.now()):{ok:true;event:ProviderEvent}|{ok:false;status:400|401|413;code:string}{
  if(raw.body.length>config.maxBodyBytes)return {ok:false,status:413,code:'WEBHOOK_TOO_LARGE'};
  const ts=raw.timestamp??'',sig=raw.signature??'';
  if(!/^[0-9]{1,12}$/.test(ts)||!/^[0-9a-f]{64}$/.test(sig)||!config.secrets.length)return {ok:false,status:401,code:'WEBHOOK_SIGNATURE'};
  if(Math.abs(nowMs/1000-Number(ts))>config.toleranceSeconds)return {ok:false,status:401,code:'WEBHOOK_TIMESTAMP'};
  const given=Buffer.from(sig,'hex');
  const valid=config.secrets.some(secret=>timingSafeEqual(Buffer.from(signWebhook(secret,ts,raw.body),'hex'),given));
  if(!valid)return {ok:false,status:401,code:'WEBHOOK_SIGNATURE'};
  const event=parseEventBody(raw.body);
  return event?{ok:true,event}:{ok:false,status:400,code:'WEBHOOK_PAYLOAD'};
}
/** Strict parse of an event body. It must be valid UTF-8, so the stored text of a dead letter replays to the same bytes and hash. */
export function parseEventBody(raw:Buffer):ProviderEvent|null{
  const text=raw.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(raw))return null;
  let body:any;try{body=JSON.parse(text);}catch{return null;}
  const ok=body&&typeof body==='object'&&typeof body.id==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(body.id)&&EVENT_TYPES.includes(body.type)
    &&typeof body.providerRef==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(body.providerRef)&&typeof body.amountPaise==='string'&&/^[0-9]{1,18}$/.test(body.amountPaise)&&typeof body.currency==='string'&&body.currency.length<=8;
  return ok?{id:body.id,type:body.type,providerRef:body.providerRef,amountPaise:BigInt(body.amountPaise),currency:body.currency}:null;
}
/**
 * Start (or resume) payment for a reserved order. The buyer must echo the order's snapshot hash, proving they accepted the
 * exact price, quantity and amount. One open attempt at a time; asking again returns it.
 */
export async function startPaymentAttempt(db:Database,actor:Actor,orderId:string,input:{acceptSnapshotHash:string},market:MarketConfig=DEFAULT_MARKET,provider='simulator'):Promise<OrderView&{attemptId:string;providerRef:string}>{
  requireBuyer(actor);
  return withScenarioLock(db,actor.scenarioId,async(tx,asOf)=>{
    await ownedOrder(tx,actor,orderId,false);
    await reapExpired(tx,actor.scenarioId,asOf,market);
    const order=await ownedOrder(tx,actor,orderId,true);
    if(!['RESERVED','AWAITING_PAYMENT'].includes(order.state))throw new WorkflowError('ORDER_NOT_PAYABLE');
    if(input?.acceptSnapshotHash!==snapshotHash(order))throw new WorkflowError('SNAPSHOT_MISMATCH');
    const open=(await tx.query(`SELECT id,provider_ref FROM demo_payment_attempts WHERE order_id=$1 AND state IN ('CREATED','PENDING') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[order.id])).rows[0];
    if(open)return {...await orderView(tx,order,{replayed:true}),attemptId:open.id,providerRef:open.provider_ref};
    const id=randomUUID(),providerRef=`sim_${id.replace(/-/g,'')}`;
    await tx.query(`INSERT INTO demo_payment_attempts(id,order_id,scenario_id,provider,provider_ref,state,amount_paise,snapshot_hash) VALUES ($1,$2,$3,$4,$5,'CREATED',$6,$7)`,
      [id,order.id,actor.scenarioId,provider,providerRef,String(order.payable_paise),snapshotHash(order)]);
    const updated=order.state==='RESERVED'?(await tx.query(`UPDATE demo_orders SET state='AWAITING_PAYMENT',version=version+1 WHERE id=$1 RETURNING *`,[order.id])).rows[0]:order;
    const anchor=await orderAnchor(tx,order.id);if(anchor)await appendAudit(tx,actor,anchor,'market.payment.started',{orderId:order.id,attemptId:id,amountPaise:String(order.payable_paise)});
    return {...await orderView(tx,updated,{replayed:false}),attemptId:id,providerRef};
  });
}
type Locked={order:Record<string,any>;attempt:Record<string,any>;items:Record<string,any>[];credits:Map<string,Record<string,any>>;generation:number};
async function lockForPayment(tx:Database,orderId:string,attemptId:string):Promise<Locked>{
  // Lock order: (scenario, already held) -> order -> attempt -> credits ascending id.
  const order=(await tx.query('SELECT * FROM demo_orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
  const attempt=(await tx.query('SELECT * FROM demo_payment_attempts WHERE id=$1 FOR UPDATE',[attemptId])).rows[0];
  const generation=Number((await tx.query('SELECT coalesce(max(generation),0) AS g FROM demo_order_items WHERE order_id=$1',[orderId])).rows[0].g);
  const items=(await tx.query('SELECT credit_id,group_id,active FROM demo_order_items WHERE order_id=$1 AND generation=$2 ORDER BY credit_id',[orderId,generation])).rows;
  const rows=(await tx.query('SELECT id,state,reserved_order_id FROM demo_credits WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[items.map(i=>i.credit_id)])).rows;
  return {order,attempt,items,generation,credits:new Map(rows.map(r=>[r.id,r]))};
}
const ownershipIntact=(l:Locked)=>['RESERVED','AWAITING_PAYMENT'].includes(l.order.state)&&l.items.length===l.order.allocated_quantity&&l.items.length>0
  &&l.items.every(i=>i.active&&l.credits.get(i.credit_id)?.state==='RESERVED'&&l.credits.get(i.credit_id)?.reserved_order_id===l.order.id);
async function refund(tx:Database,l:Locked,kind:'LATE_UNFILLABLE'|'DUPLICATE_ATTEMPT'|'AMOUNT_MISMATCH',amount:bigint){
  if(amount<=0n)return;
  await tx.query(`INSERT INTO demo_payment_refunds(order_id,attempt_id,scenario_id,kind,amount_paise) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (attempt_id,kind) DO NOTHING`,[l.order.id,l.attempt.id,l.order.scenario_id,kind,String(amount)]);
}
const succeed=(tx:Database,attemptId:string,mismatch=false)=>tx.query(`UPDATE demo_payment_attempts SET state='SUCCEEDED',mismatch=$2 WHERE id=$1 AND state<>'SUCCEEDED'`,[attemptId,mismatch]);
/**
 * Credits SOLD, one ledger line each with its earnings (docs/23 §6.1: journals, lots, payee locks), group waiting reset,
 * attempt SUCCEEDED, order FULFILLED (docs/22 §6.1 step 4).
 */
async function fulfil(tx:Database,l:Locked,creditIds:string[],groups:string[],asOf:Date){
  const unitPrice=money(l.order.unit_price_paise),line=ledgerLine(unitPrice,l.order.commission_bps);
  await tx.query(`UPDATE demo_credits SET state='SOLD' WHERE id=ANY($1::text[])`,[creditIds]);
  const ledger=(await tx.query(`INSERT INTO demo_ledger_entries(order_id,scenario_id,credit_id,payee_group_id,gross_paise,commission_paise,net_paise) SELECT $1,$2,x.c,x.g,$5,$6,$7 FROM unnest($3::text[],$4::uuid[]) AS x(c,g)
    RETURNING id::text AS id,payee_group_id::text AS payee`,[l.order.id,l.order.scenario_id,creditIds,groups,String(line.gross),String(line.commission),String(line.net)])).rows;
  await postEarnings(tx,l.order.scenario_id,ledger.map(r=>({ledgerEntryId:r.id as string,payeeGroupId:r.payee as string,grossPaise:line.gross,commissionPaise:line.commission,netPaise:line.net})));
  await tx.query(`INSERT INTO demo_group_state(scenario_id,group_id,last_allocated_at) SELECT $1,g,$3 FROM unnest($2::uuid[]) AS g ON CONFLICT (scenario_id,group_id) DO UPDATE SET last_allocated_at=EXCLUDED.last_allocated_at`,
    [l.order.scenario_id,[...new Set(groups)],asOf]);
  await succeed(tx,l.attempt.id);
  await tx.query(`UPDATE demo_orders SET state='FULFILLED',version=version+1 WHERE id=$1`,[l.order.id]);
}
async function apply(tx:Database,ev:ProviderEvent,l:Locked,asOf:Date,config:PaymentConfig):Promise<PaymentOutcome>{
  const {order,attempt}=l,success=ev.type==='payment.succeeded';
  if(success){
    // Checked first so that no branch can strand captured money: a wrong amount is refunded, whatever state the order is in.
    if(ev.amountPaise!==money(attempt.amount_paise)||ev.currency!=='INR'||money(attempt.amount_paise)!==money(order.payable_paise)){
      await succeed(tx,attempt.id,true);await refund(tx,l,'AMOUNT_MISMATCH',ev.amountPaise);return 'AMOUNT_MISMATCH';
    }
    // The same charge reported again (a new event id for an attempt whose correct-amount success was already applied) is not a
    // second payment. A wrong-amount success does not count: it was refunded on its own, so a correct one after it is a real
    // payment and goes on to the branches below (docs/22 §6.1), instead of being ignored with the money never returned.
    if(attempt.state==='SUCCEEDED'&&(await tx.query(`SELECT 1 FROM demo_payment_events WHERE attempt_id=$1 AND type='payment.succeeded'
      AND outcome IN ('FULFILLED','REVALIDATED_FULFILLED','REFUND_LATE_UNFILLABLE','REFUND_DUPLICATE_ATTEMPT') LIMIT 1`,[attempt.id])).rows.length)return 'IGNORED_SAME_ATTEMPT';
  }else{
    if(!['CREATED','PENDING'].includes(attempt.state))return 'IGNORED_TERMINAL';
    const next=ev.type==='payment.pending'?'PENDING':ev.type==='payment.failed'?'FAILED':'CANCELLED';
    await tx.query('UPDATE demo_payment_attempts SET state=$2 WHERE id=$1',[attempt.id,next]);
    if(next==='PENDING'&&['RESERVED','AWAITING_PAYMENT'].includes(order.state)&&order.allocated_at){
      const cap=new Date(order.allocated_at).getTime()+config.maxHoldSeconds*1000;
      const until=Math.min(Math.max(new Date(order.reserved_until).getTime(),asOf.getTime()+config.pendingExtensionSeconds*1000),cap);
      await tx.query('UPDATE demo_orders SET reserved_until=$2 WHERE id=$1',[order.id,new Date(until)]);
    }
    return 'ATTEMPT_UPDATED';
  }
  // A different attempt succeeding after the order is settled is a double charge: refund it, leave the order alone.
  if(['FULFILLED','REFUND_PENDING','REFUNDED'].includes(order.state)){
    await succeed(tx,attempt.id);await refund(tx,l,'DUPLICATE_ATTEMPT',ev.amountPaise);return 'REFUND_DUPLICATE_ATTEMPT';
  }
  // Ownership intact, even if reserved_until has passed but the reaper has not run: the payment is honoured.
  if(ownershipIntact(l)){await fulfil(tx,l,l.items.map(i=>i.credit_id),l.items.map(i=>i.group_id),asOf);return 'FULFILLED';}
  if(!['RESERVED','AWAITING_PAYMENT','EXPIRED','CANCELLED'].includes(order.state))throw new WorkflowError('PAYMENT_ORDER_STATE',503);
  // Late success (expired, cancelled, or holds gone): re-reserve the SAME credits, all or nothing; otherwise refund in full.
  await tx.query(`UPDATE demo_orders SET state='REVALIDATING',version=version+1 WHERE id=$1`,[order.id]);
  const ids=l.items.map(i=>i.credit_id),groups=l.items.map(i=>i.group_id);
  if(ids.length&&ids.every(id=>l.credits.get(id)?.state==='AVAILABLE')){
    await tx.query(`INSERT INTO demo_order_items(order_id,scenario_id,credit_id,group_id,generation) SELECT $1,$2,x.c,x.g,$5 FROM unnest($3::text[],$4::uuid[]) AS x(c,g)`,[order.id,order.scenario_id,ids,groups,l.generation+1]);
    await tx.query(`UPDATE demo_credits SET state='RESERVED',reserved_order_id=$1 WHERE id=ANY($2::text[])`,[order.id,ids]);
    await fulfil(tx,l,ids,groups,asOf);return 'REVALIDATED_FULFILLED';
  }
  await succeed(tx,attempt.id);
  await tx.query(`UPDATE demo_orders SET state='REFUND_PENDING',version=version+1 WHERE id=$1`,[order.id]);
  await refund(tx,l,'LATE_UNFILLABLE',ev.amountPaise);return 'REFUND_LATE_UNFILLABLE';
}
const isUniqueViolation=(error:unknown)=>(error as {code?:unknown})?.code==='23505';
/**
 * Webhook entry point. Must be called with no transaction open (it takes the scenario lock itself).
 * 200 = applied or already applied (idempotent), or parked as a dead letter; 401/413/400 = rejected before any write;
 * 404 = unknown attempt, nothing written; 409 = the event id was reused with a different body; 503 = the apply failed and was
 * rolled back, so the provider should retry (until the event is parked after maxEventFailures).
 */
export async function handlePaymentEvent(db:Database,raw:RawWebhook,config:PaymentConfig,nowMs=Date.now()):Promise<WebhookResult>{
  const verified=verifyWebhook(raw,config,nowMs);
  if(!verified.ok)return {status:verified.status,code:verified.code};
  return applyProviderEvent(db,verified.event,raw.body,config,'delivery');
}
async function applyProviderEvent(db:Database,ev:ProviderEvent,body:Buffer,config:PaymentConfig,mode:'delivery'|'operator-retry'):Promise<WebhookResult>{
  const payloadHash=sha256(body);
  // Immutable columns, so an unlocked read is enough to find the scenario lock to take.
  const target=(await db.query('SELECT id,order_id,scenario_id FROM demo_payment_attempts WHERE provider=$1 AND provider_ref=$2',[config.provider,ev.providerRef])).rows[0];
  if(!target)return {status:404,code:'PAYMENT_UNMATCHED',eventId:ev.id};
  const failure=(await db.query('SELECT payload_hash,parked FROM demo_payment_event_failures WHERE provider=$1 AND provider_event_id=$2',[config.provider,ev.id])).rows[0];
  if(failure&&failure.payload_hash!==payloadHash)return {status:409,code:'EVENT_REUSE'};
  // A parked event is not re-applied by provider redeliveries; only an operator retry applies it.
  if(failure?.parked&&mode==='delivery')return {status:200,code:'EVENT_PARKED',parked:true,eventId:ev.id};
  const stored=async(tx:Database):Promise<WebhookResult|undefined>=>{
    const prior=(await tx.query('SELECT payload_hash,outcome FROM demo_payment_events WHERE provider=$1 AND provider_event_id=$2',[config.provider,ev.id])).rows[0];
    if(!prior)return undefined;
    return prior.payload_hash===payloadHash?{status:200,outcome:prior.outcome,replayed:true}:{status:409,code:'EVENT_REUSE'};
  };
  try{
    return await withScenarioLock(db,target.scenario_id,async(tx,asOf)=>{
      const prior=await stored(tx);if(prior)return prior;
      const locked=await lockForPayment(tx,target.order_id,target.id);
      const outcome=await apply(tx,ev,locked,asOf,config);
      if(outcome!=='IGNORED_SAME_ATTEMPT'&&outcome!=='IGNORED_TERMINAL'){
        const anchor=await orderAnchor(tx,target.order_id);
        if(anchor)await appendAudit(tx,systemActor(target.scenario_id),anchor,'market.payment.applied',{orderId:target.order_id,attemptId:target.id,eventId:ev.id,type:ev.type,outcome});
      }
      // A successful apply retires any earlier failure record, in the same transaction.
      await tx.query('DELETE FROM demo_payment_event_failures WHERE provider=$1 AND provider_event_id=$2',[config.provider,ev.id]);
      // Last write of the transaction: the event is only ever recorded together with its effect.
      await tx.query(`INSERT INTO demo_payment_events(provider,provider_event_id,attempt_id,scenario_id,type,payload_hash,amount_paise,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [config.provider,ev.id,target.id,target.scenario_id,ev.type,payloadHash,String(ev.amountPaise),outcome]);
      return {status:200,outcome};
    });
  }catch(error){
    if(isUniqueViolation(error)){const prior=await db.transaction(stored);if(prior)return prior;}
    const code=error instanceof WorkflowError?error.code:'PAYMENT_APPLY_FAILED',cause=safeErrorFields(error);
    // Recorded after the rollback, outside the failed transaction, so the count survives it.
    let recorded:{parked:boolean;failures:number};
    try{
      recorded=(await db.query<{parked:boolean;failures:number}>(`INSERT INTO demo_payment_event_failures(provider,provider_event_id,attempt_id,scenario_id,payload_hash,body,failures,last_code,last_error_name,last_error_code,parked)
          VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10::int<=1)
        ON CONFLICT (provider,provider_event_id) DO UPDATE SET failures=demo_payment_event_failures.failures+1,last_code=EXCLUDED.last_code,last_error_name=EXCLUDED.last_error_name,
          last_error_code=EXCLUDED.last_error_code,last_failed_at=now(),parked=demo_payment_event_failures.parked OR demo_payment_event_failures.failures+1>=$10::int
        RETURNING parked,failures`,[config.provider,ev.id,target.id,target.scenario_id,payloadHash,body.toString('utf8'),code,cause.errorName,cause.errorCode??null,config.maxEventFailures])).rows[0];
    }catch{
      // Usually the database itself is down. Nothing is lost: the provider retries and the next delivery is recorded.
      return {status:503,code,eventId:ev.id,error:cause,failureNotRecorded:true};
    }
    // Exactly one increment reaches the bound, even when deliveries race, so "just parked" is reported once.
    if(recorded.parked&&mode==='delivery')return {status:200,code:'EVENT_PARKED',parked:true,justParked:recorded.failures===config.maxEventFailures,eventId:ev.id,error:cause};
    return {status:503,code,eventId:ev.id,error:cause};
  }
}
/** Operator action: apply a parked event again (its stored body, no provider needed). It stays parked if it fails again. */
export async function retryParkedPaymentEvent(db:Database,provider:string,eventId:string,config:PaymentConfig):Promise<WebhookResult>{
  const row=(await db.query('SELECT body FROM demo_payment_event_failures WHERE provider=$1 AND provider_event_id=$2 AND parked',[provider,eventId])).rows[0];
  if(!row)throw new WorkflowError('PAYMENT_EVENT_NOT_PARKED',404);
  const body=Buffer.from(String(row.body),'utf8'),ev=parseEventBody(body);
  if(!ev)throw new WorkflowError('PAYMENT_EVENT_UNREADABLE',500);
  return applyProviderEvent(db,ev,body,{...config,provider},'operator-retry');
}
/** Failing and parked events for operators and dashboards. The stored body is not returned. */
export async function listFailedPaymentEvents(db:Database,options:{parkedOnly?:boolean}={}){
  const rows=(await db.query(`SELECT provider,provider_event_id,attempt_id,scenario_id,failures,last_code,last_error_name,last_error_code,parked,first_failed_at,last_failed_at
    FROM demo_payment_event_failures WHERE ($1::boolean IS NOT TRUE OR parked) ORDER BY last_failed_at DESC LIMIT 100`,[options.parkedOnly??false])).rows;
  return rows.map(r=>({provider:r.provider as string,eventId:r.provider_event_id as string,attemptId:r.attempt_id as string,scenarioId:r.scenario_id as string,failures:r.failures as number,
    lastCode:r.last_code as string,lastErrorName:(r.last_error_name??null) as string|null,lastErrorCode:(r.last_error_code??null) as string|null,parked:r.parked as boolean,
    firstFailedAt:new Date(r.first_failed_at).toISOString(),lastFailedAt:new Date(r.last_failed_at).toISOString()}));
}
/** Settle pending refunds (the simulator's provider confirmation), then close orders whose refunds are all settled. */
export async function settleRefunds(db:Database,scenarioId:string,options:{olderThanSeconds?:number}={}){
  return withScenarioLock(db,scenarioId,async(tx,asOf)=>{
    const orders=(await tx.query(`SELECT id FROM demo_orders WHERE scenario_id=$1 AND state='REFUND_PENDING' ORDER BY id FOR UPDATE`,[scenarioId])).rows.map(r=>r.id as string);
    // The worker settles only refunds older than a delay, so REFUND_PENDING stays visible in the demo; the presenter settles all.
    const settled=(await tx.query(`UPDATE demo_payment_refunds SET state='REFUNDED' WHERE scenario_id=$1 AND state='PENDING' AND created_at<=$2::timestamptz-make_interval(secs=>$3) RETURNING order_id`,[scenarioId,asOf,options.olderThanSeconds??0])).rows.length;
    let closed=0;
    for(const id of orders){
      if((await tx.query(`SELECT 1 FROM demo_payment_refunds WHERE order_id=$1 AND state='PENDING'`,[id])).rows.length)continue;
      await tx.query(`UPDATE demo_orders SET state='REFUNDED',version=version+1 WHERE id=$1`,[id]);closed++;
      const anchor=await orderAnchor(tx,id);if(anchor)await appendAudit(tx,systemActor(scenarioId),anchor,'market.order.refunded',{orderId:id});
    }
    return {settled,closed};
  });
}
