import type {Database} from '../../../kernel/database.js';
import {safeErrorFields} from '../../../kernel/errors.js';
import type {Logger} from '../../../kernel/logger.js';
import type {Metrics} from '../../../kernel/metrics.js';
import {PAYOUT_STATES} from '../domain/state.js';
import type {PayoutRail} from '../domain/rail.js';
import {runDueBatches} from './batch.js';
import {simNow} from './clock.js';
import {assertPayoutInvariants,PAYOUT_INVARIANT_CODES,type PayoutViolation} from './invariants.js';
import {runSettlementCycle} from './settlement.js';
/**
 * The worker's payout step (docs/23 §6.2-6.3, §9): per demo scenario, run due batches, then tick the rail and send, resolve and
 * poll. Each scenario is isolated, so a broken rail in one never stops the others or the rest of the worker cycle. The ledger
 * invariants run on a schedule, one snapshot per scenario.
 */
export type PayoutSweepState={lastInvariantAt:number;lastViolationKey:string};
export const newPayoutSweepState=():PayoutSweepState=>({lastInvariantAt:0,lastViolationKey:''});
export type PayoutSweepDeps={rail:PayoutRail;state:PayoutSweepState;invariantEverySeconds:number};
export function declarePayoutWorkerMetrics(metrics:Metrics){
  metrics
    .declare('greenchain_payouts','gauge','Payouts by state.')
    .declare('greenchain_payouts_attention','gauge','Payouts needing attention (NEEDS_REVIEW, UNRESOLVED, INDETERMINATE), by state.')
    .declare('greenchain_payout_attention_oldest_age_seconds','gauge','Age of the oldest payout needing attention, by state (0 when none).')
    .declare('greenchain_payout_sent_oldest_age_seconds','gauge','Age of the oldest SENT payout not yet settled (0 when none).')
    .declare('greenchain_payout_rollovers_total','counter','Payees whose releasable total was below the minimum in a batch.')
    .declare('greenchain_payout_lag_seconds','gauge','Simulated age of the oldest releasable lot not yet in a payout (0 when none).')
    .declare('greenchain_payout_clearing_paise','gauge','Balance of payout_clearing: money in payouts not yet settled or reversed.')
    .declare('greenchain_reversal_reserve_paise','gauge','Balance of the reversal reserve.')
    .declare('greenchain_ledger_invariant_violations','gauge','Payout ledger invariant violations from the last check, by code (docs/23 §8). Any non-zero value is a bug.')
    .declare('greenchain_payout_last_batch_age_seconds','gauge','Seconds since the newest payout batch, across demo scenarios (-1 if none).')
    .declare('greenchain_payout_sweep_failures_total','counter','Payout steps that failed for a scenario (the rest of the worker cycle still ran).');
}
export async function payoutSweep(db:Database,o:PayoutSweepDeps&{metrics?:Metrics;log?:Logger;now?:()=>number}):Promise<{worked:boolean}>{
  const {metrics,log,state}=o,now=o.now??Date.now;
  const namespaces=(await db.query('SELECT scenario_id,retired_at IS NOT NULL AS retired FROM demo_namespaces ORDER BY scenario_id')).rows as {scenario_id:string;retired:boolean}[];
  const scenarios=namespaces.map(n=>n.scenario_id),retired=new Set(namespaces.filter(n=>n.retired).map(n=>n.scenario_id));
  let worked=false;
  for(const scenario of scenarios){
    try{
      const onError=(error:unknown)=>log?.warn({scenario,...safeErrorFields(error)},'Payout step error');
      // A retired scenario starts no new runs, but money already in flight there is followed to a final state.
      for(const b of await runDueBatches(db,scenario,{onPayeeError:onError,scheduled:!retired.has(scenario)})){
        metrics?.inc('greenchain_payout_rollovers_total',{},b.rolledOver);
        if(b.payouts||b.rolledOver||b.failedPayees||b.oversizedLots)log?.info({scenario,batchId:b.batchId,runDate:b.runDate,runSeq:b.runSeq,status:b.status,payouts:b.payouts,
          rolledOver:b.rolledOver,skippedReverify:b.skippedReverify,oversizedLots:b.oversizedLots,failedPayees:b.failedPayees},'Payout batch');
        worked||=b.payouts>0;
      }
      const s=await runSettlementCycle(db,scenario,{rail:o.rail,log,onError});
      worked||=s.sent+s.reconciled>0;
    }catch(error){
      metrics?.inc('greenchain_payout_sweep_failures_total');
      log?.error({scenario,...safeErrorFields(error)},'Payout step failed');
    }
  }
  if(now()-state.lastInvariantAt>=o.invariantEverySeconds*1000){
    const violations:PayoutViolation[]=[];
    for(const scenario of scenarios)violations.push(...await assertPayoutInvariants(db,scenario));
    state.lastInvariantAt=now();
    const byCode=new Map<string,PayoutViolation[]>();for(const v of violations)byCode.set(v.code,[...(byCode.get(v.code)??[]),v]);
    for(const code of PAYOUT_INVARIANT_CODES)metrics?.set('greenchain_ledger_invariant_violations',byCode.get(code)?.length??0,{code});
    const key=[...byCode].map(([code,list])=>`${code}:${list.length}`).sort().join(',');
    if(key!==state.lastViolationKey){
      if(violations.length)for(const [code,list] of byCode)log?.error({code,count:list.length,examples:list.slice(0,3).map(v=>v.ref)},'Payout ledger invariant violated');
      else if(state.lastViolationKey)log?.info({},'Payout ledger invariants hold again');
      state.lastViolationKey=key;
    }
  }
  if(metrics){
    const byState=new Map((await db.query('SELECT state,count(*)::int AS n FROM demo_payouts GROUP BY state')).rows.map(r=>[r.state as string,r.n as number]));
    for(const s of PAYOUT_STATES)metrics.set('greenchain_payouts',byState.get(s)??0,{state:s});
    const ages=new Map((await db.query(`SELECT state,coalesce(max(extract(epoch FROM now()-updated_at)),0)::float8 AS age FROM demo_payouts
      WHERE state IN ('NEEDS_REVIEW','UNRESOLVED','INDETERMINATE','SENT') GROUP BY state`)).rows.map(r=>[r.state as string,Math.round(Number(r.age))]));
    for(const s of ['NEEDS_REVIEW','UNRESOLVED','INDETERMINATE']){metrics.set('greenchain_payouts_attention',byState.get(s)??0,{state:s});metrics.set('greenchain_payout_attention_oldest_age_seconds',ages.get(s)??0,{state:s});}
    metrics.set('greenchain_payout_sent_oldest_age_seconds',ages.get('SENT')??0);
    const balance=async(account:string)=>Number((await db.query(`SELECT coalesce(sum(CASE side WHEN 'CR' THEN amount_paise ELSE -amount_paise END),0)::text AS b FROM demo_journal_lines WHERE account=$1`,[account])).rows[0].b);
    metrics.set('greenchain_payout_clearing_paise',await balance('payout_clearing'));
    metrics.set('greenchain_reversal_reserve_paise',await balance('reversal_reserve'));
    let lag=0;
    for(const scenario of scenarios){
      const sim=(await db.transaction(tx=>simNow(tx,scenario))).sim;
      const oldest=(await db.query(`SELECT min(l.releasable_at_sim) AS t FROM demo_earning_lots l
        JOIN LATERAL (SELECT state FROM demo_lot_events WHERE ledger_entry_id=l.ledger_entry_id ORDER BY seq DESC LIMIT 1) ev ON true
        WHERE l.scenario_id=$1 AND ev.state IN ('EARNED','RELEASED') AND l.releasable_at_sim<=$2`,[scenario,sim])).rows[0].t;
      if(oldest)lag=Math.max(lag,Math.round((sim.getTime()-new Date(oldest).getTime())/1000));
    }
    metrics.set('greenchain_payout_lag_seconds',lag);
    const last=(await db.query('SELECT extract(epoch FROM now()-max(created_at))::float8 AS age FROM demo_payout_batches')).rows[0].age;
    metrics.set('greenchain_payout_last_batch_age_seconds',last===null?-1:Math.round(Number(last)));
  }
  return {worked};
}
