import type {Database} from '../../../kernel/database.js';
import type {Logger} from '../../../kernel/logger.js';
import type {Metrics} from '../../../kernel/metrics.js';
import {assertMarketInvariants,INVARIANT_CODES,type Violation} from './invariants.js';
import {withScenarioLock} from './lock.js';
import {ORDER_STATES,PAYMENT_OUTCOMES} from './metrics.js';
import {DEFAULT_MARKET,reapExpired,type MarketConfig} from './orders.js';
import {settleRefunds} from './payments.js';
/**
 * The worker's market step. Reservations are also reaped lazily whenever someone orders, so the sweep is what keeps quiet
 * scenarios tidy and is the backstop for the "no reservation outlives its expiry" invariant (docs/22 §8.3).
 * It takes a scenario lock only when an unlocked pre-check finds work, so an idle market never contends with buyers.
 */
export type SweepConfig={
  market:MarketConfig;
  /** Settle refunds once they are this old (the simulated provider confirming them). null leaves settlement to the presenter. */
  refundSettleAfterSeconds:number|null;
  invariantEverySeconds:number;
  lapseGraceSeconds:number;
};
export const DEFAULT_SWEEP:SweepConfig={market:DEFAULT_MARKET,refundSettleAfterSeconds:600,invariantEverySeconds:60,lapseGraceSeconds:120};
export type SweepState={lastInvariantAt:number;lastViolationKey:string};
export const newSweepState=():SweepState=>({lastInvariantAt:0,lastViolationKey:''});
export type SweepResult={expired:number;released:number;shortfallsCancelled:number;refundsSettled:number;violations?:Violation[];worked:boolean};
function integer(env:NodeJS.ProcessEnv,name:string,fallback:number,min:number,max:number){
  const raw=env[name];if(raw===undefined||raw==='')return fallback;
  const value=Number(raw);
  if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function sweepConfigFromEnvironment(market:MarketConfig,env:NodeJS.ProcessEnv=process.env):SweepConfig{
  const refund=env.MARKET_REFUND_SETTLE_SECONDS==='off'?null:integer(env,'MARKET_REFUND_SETTLE_SECONDS',DEFAULT_SWEEP.refundSettleAfterSeconds!,0,86_400);
  return {market,refundSettleAfterSeconds:refund,invariantEverySeconds:integer(env,'MARKET_INVARIANT_EVERY_SECONDS',DEFAULT_SWEEP.invariantEverySeconds,10,86_400),
    lapseGraceSeconds:integer(env,'MARKET_LAPSE_GRACE_SECONDS',DEFAULT_SWEEP.lapseGraceSeconds,5,3_600)};
}
export async function marketSweep(db:Database,o:{config:SweepConfig;state:SweepState;metrics?:Metrics;log?:Logger;now?:()=>number}):Promise<SweepResult>{
  const {config,state,metrics,log}=o,now=o.now??Date.now;
  const result:SweepResult={expired:0,released:0,shortfallsCancelled:0,refundsSettled:0,worked:false};
  const scenarios=(await db.query('SELECT scenario_id FROM demo_namespaces ORDER BY scenario_id')).rows.map(r=>r.scenario_id as string);
  for(const scenario of scenarios){
    const due=(await db.query(`SELECT
        EXISTS (SELECT 1 FROM demo_orders WHERE scenario_id=$1 AND ((state IN ('RESERVED','AWAITING_PAYMENT') AND reserved_until<=now()) OR (state='CREATED' AND created_at<=now()-make_interval(secs=>$2)))) AS reap,
        ($3::int IS NOT NULL AND EXISTS (SELECT 1 FROM demo_payment_refunds WHERE scenario_id=$1 AND state='PENDING' AND created_at<=now()-make_interval(secs=>coalesce($3::int,0)))) AS refund`,
      [scenario,config.market.shortfallHoldSeconds,config.refundSettleAfterSeconds])).rows[0];
    if(due.reap){
      const r=await withScenarioLock(db,scenario,(tx,asOf)=>reapExpired(tx,scenario,asOf,config.market));
      result.expired+=r.expired;result.released+=r.released;result.shortfallsCancelled+=r.shortfallsCancelled;
    }
    if(due.refund&&config.refundSettleAfterSeconds!==null){
      result.refundsSettled+=(await settleRefunds(db,scenario,{olderThanSeconds:config.refundSettleAfterSeconds})).settled;
    }
  }
  result.worked=result.expired+result.shortfallsCancelled+result.refundsSettled>0;
  if(result.worked)log?.info({expired:result.expired,released:result.released,shortfallsCancelled:result.shortfallsCancelled,refundsSettled:result.refundsSettled},'Market sweep');
  if(now()-state.lastInvariantAt>=config.invariantEverySeconds*1000){
    const violations=await assertMarketInvariants(db,{lapseGraceSeconds:config.lapseGraceSeconds});
    state.lastInvariantAt=now();result.violations=violations;
    const byCode=new Map<string,Violation[]>();for(const v of violations)byCode.set(v.code,[...(byCode.get(v.code)??[]),v]);
    for(const code of INVARIANT_CODES)metrics?.set('greenchain_market_invariant_violations',byCode.get(code)?.length??0,{code});
    // Log a changed finding once, not every check. Refs are internal order/credit ids, never farmer data.
    const key=[...byCode].map(([code,list])=>`${code}:${list.length}`).sort().join(',');
    if(key!==state.lastViolationKey){
      if(violations.length)for(const [code,list] of byCode)log?.error({code,count:list.length,examples:list.slice(0,3).map(v=>v.ref)},'Market invariant violated');
      else if(state.lastViolationKey)log?.info({},'Market invariants hold again');
      state.lastViolationKey=key;
    }
  }
  if(metrics){
    metrics.inc('greenchain_reservations_reaped_total',{},result.expired);
    metrics.inc('greenchain_shortfall_offers_cancelled_total',{},result.shortfallsCancelled);
    metrics.inc('greenchain_refunds_settled_total',{},result.refundsSettled);
    const orders=new Map((await db.query('SELECT state,count(*)::int AS n FROM demo_orders GROUP BY state')).rows.map(r=>[r.state as string,r.n as number]));
    for(const s of ORDER_STATES)metrics.set('greenchain_orders',orders.get(s)??0,{state:s});
    const refunds=(await db.query(`SELECT count(*)::int AS n,coalesce(max(extract(epoch FROM now()-created_at)),0)::float8 AS oldest FROM demo_payment_refunds WHERE state='PENDING'`)).rows[0];
    metrics.set('greenchain_refunds_pending',refunds.n);metrics.set('greenchain_refund_oldest_pending_age_seconds',Math.round(Number(refunds.oldest)));
    const events=new Map((await db.query('SELECT outcome,count(*)::int AS n FROM demo_payment_events GROUP BY outcome')).rows.map(r=>[r.outcome as string,r.n as number]));
    for(const outcome of PAYMENT_OUTCOMES)metrics.set('greenchain_payment_events',events.get(outcome)??0,{outcome});
    metrics.set('greenchain_market_invariant_check_age_seconds',state.lastInvariantAt?Math.round((now()-state.lastInvariantAt)/1000):-1);
  }
  return result;
}
