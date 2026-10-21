import {randomUUID} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
import type {Actor} from '../../capture/application/capture.js';
import {withScenarioLock} from '../application/lock.js';
import {reapExpired,DEFAULT_MARKET} from '../application/orders.js';
import {handlePaymentEvent,settleRefunds,signWebhook,type PaymentConfig,type ProviderEvent,type WebhookResult} from '../application/payments.js';
/**
 * Deterministic stand-in for a payment provider (docs/22 B9). It builds and signs events exactly as a provider would and
 * delivers them through the same handler, so every demo outcome exercises the real code path. Never used for real money.
 */
export const SIMULATED_OUTCOMES=['pending','success','failure','replay','double_charge','late_success','refund'] as const;
export type SimulatedOutcome=typeof SIMULATED_OUTCOMES[number];
/** Canonical body: fixed key order, so rebuilding a stored event reproduces its exact bytes (and payload hash). */
export function eventBody(ev:Omit<ProviderEvent,'amountPaise'>&{amountPaise:bigint|string}){
  return Buffer.from(JSON.stringify({id:ev.id,type:ev.type,providerRef:ev.providerRef,amountPaise:String(ev.amountPaise),currency:ev.currency}));
}
export function signedDelivery(config:PaymentConfig,body:Buffer,nowMs=Date.now()){
  const timestamp=String(Math.floor(nowMs/1000));
  return {body,timestamp,signature:signWebhook(config.secrets[0],timestamp,body)};
}
const TYPE={pending:'payment.pending',success:'payment.succeeded',late_success:'payment.succeeded',double_charge:'payment.succeeded',failure:'payment.failed'} as const;
/**
 * Presenter control. Any prelude (moving the reservation clock, reaping, adding a second attempt) runs in its OWN committed
 * transaction; the event is then delivered with no transaction open, so the handler can take the scenario lock itself.
 */
export async function simulate(db:Database,actor:Actor,orderId:string,outcome:SimulatedOutcome,config:PaymentConfig):Promise<WebhookResult|{status:200;settled:number;closed:number}>{
  if(actor.role!=='agent')throw new WorkflowError('FORBIDDEN',403);
  if(!SIMULATED_OUTCOMES.includes(outcome))throw new WorkflowError('INVALID_OUTCOME',422);
  if(outcome==='refund'){const r=await settleRefunds(db,actor.scenarioId);return {status:200,...r};}
  const attempt=await withScenarioLock(db,actor.scenarioId,async(tx,asOf)=>{
    const order=(await tx.query('SELECT id,payable_paise FROM demo_orders WHERE id=$1 AND scenario_id=$2 FOR UPDATE',[orderId,actor.scenarioId])).rows[0];
    if(!order)throw new WorkflowError('NOT_FOUND',404);
    let latest=(await tx.query('SELECT id,provider_ref,amount_paise,state FROM demo_payment_attempts WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE',[order.id])).rows[0];
    if(!latest)throw new WorkflowError('NO_PAYMENT_ATTEMPT');
    if(outcome==='late_success'){
      await tx.query(`UPDATE demo_orders SET reserved_until=$2 WHERE id=$1 AND state IN ('RESERVED','AWAITING_PAYMENT')`,[order.id,new Date(asOf.getTime()-1000)]);
      await reapExpired(tx,actor.scenarioId,asOf,DEFAULT_MARKET);
    }
    if(outcome==='double_charge'){
      // A second checkout that also captures money, the way a buyer paying twice in two tabs would.
      const id=randomUUID();
      latest=(await tx.query(`INSERT INTO demo_payment_attempts(id,order_id,scenario_id,provider,provider_ref,state,amount_paise) VALUES ($1,$2,$3,$4,$5,'CREATED',$6) RETURNING id,provider_ref,amount_paise,state`,
        [id,order.id,actor.scenarioId,config.provider,`sim_${id.replace(/-/g,'')}`,String(latest.amount_paise)])).rows[0];
    }
    if(outcome==='replay'){
      const last=(await tx.query(`SELECT e.provider_event_id,e.type,e.amount_paise,a.provider_ref FROM demo_payment_events e JOIN demo_payment_attempts a ON a.id=e.attempt_id WHERE a.order_id=$1 ORDER BY e.received_at DESC LIMIT 1`,[order.id])).rows[0];
      if(!last)throw new WorkflowError('NOTHING_TO_REPLAY');
      return {replay:{id:last.provider_event_id as string,type:last.type,providerRef:last.provider_ref as string,amountPaise:String(last.amount_paise),currency:'INR'}};
    }
    return {attempt:latest};
  });
  const body='replay' in attempt
    ?eventBody(attempt.replay as any)
    :eventBody({id:`evt_${randomUUID().replace(/-/g,'')}`,type:TYPE[outcome as keyof typeof TYPE],providerRef:attempt.attempt.provider_ref,amountPaise:String(attempt.attempt.amount_paise),currency:'INR'});
  return handlePaymentEvent(db,signedDelivery(config,body),config);
}
