import type {Database} from '../../../kernel/database.js';
import {WorkflowError,safeErrorFields} from '../../../kernel/errors.js';
import type {Logger} from '../../../kernel/logger.js';
import type {Metrics} from '../../../kernel/metrics.js';
import {auditIntegrity,verifyAuditFull} from '../../audit/application/audit.js';
import type {ChainPort} from '../../chain/application/port.js';
import {proofStats,runChainCycle,type CycleOptions} from '../../chain/application/worker.js';
import {declareMarketWorkerMetrics} from '../../market/application/metrics.js';
import {marketSweep,type SweepConfig,type SweepResult,type SweepState} from '../../market/application/sweep.js';
export const PROOF_STATUSES=['QUEUED','PREPARED','PENDING','RECONCILING','CONFIRMED','FAILED'] as const;
/** Everything the worker exports. Label values come from fixed sets (result, status, error code), so cardinality is bounded. */
export function declareWorkerMetrics(metrics:Metrics){
  metrics
    .declare('greenchain_worker_cycles_total','counter','Worker cycles by result (ok, halted, error).')
    .declare('greenchain_worker_cycle_duration_seconds','gauge','Duration of the most recent worker cycle.')
    .declare('greenchain_worker_last_success_timestamp_seconds','gauge','Unix time of the last completed worker cycle.')
    .declare('greenchain_worker_consecutive_failures','gauge','Worker cycles that failed in a row (0 when healthy).')
    .declare('greenchain_proof_failures_total','counter','Proof steps that failed, by safe error code.')
    .declare('greenchain_proofs','gauge','Proofs by status.')
    .declare('greenchain_proof_oldest_unfinished_age_seconds','gauge','Age of the oldest proof that is neither CONFIRMED nor FAILED.')
    .declare('greenchain_audit_pending_events','gauge','Audit events waiting to be chained.')
    .declare('greenchain_audit_verification_lag_links','gauge','Chained links not yet covered by the verification checkpoint.')
    .declare('greenchain_audit_integrity_failed','gauge','1 when audit verification has found a problem and the worker is halted.')
    .declare('greenchain_audit_full_verification_age_seconds','gauge','Seconds since the last full audit verification (-1 if never).')
    .declare('greenchain_audit_full_verifications_total','counter','Full audit verifications by result.')
    .declare('greenchain_jobs_pending','gauge','Capture jobs not yet processed.');
  declareMarketWorkerMetrics(metrics);
}
export type HealthState={name:string;startedAt:number;lastSuccessAt:number|null;lastResult:string|null;lastErrorCode:string|null;consecutiveFailures:number;integrityFailed:boolean;nextFullVerifyAt:number};
export const newHealthState=(name:string,now=Date.now()):HealthState=>({name,startedAt:now,lastSuccessAt:null,lastResult:null,lastErrorCode:null,consecutiveFailures:0,integrityFailed:false,nextFullVerifyAt:0});
export type WorkerDeps={db:Database;chain?:ChainPort;log:Logger;metrics:Metrics;health:HealthState;now?:()=>number;
  /** Full audit re-verification interval; 0 disables it. */fullVerifyEveryMs?:number;cycle?:CycleOptions;
  /** The buyer-market sweep (docs/22 §6.2); omitted means no market step. */market?:{config:SweepConfig;state:SweepState}};
export type CycleOutcome={ok:boolean;idle:boolean;result:string;errorCode?:string};
const IDLE_RESULTS=new Set(['IDLE','NOT_CONFIGURED','BUSY','HALTED_INTEGRITY']);
const errorCodeOf=(error:unknown)=>error instanceof WorkflowError?error.code:safeErrorFields(error).errorCode??'UNKNOWN';
/** The foundation job consumer: records delivery of a capture. It makes no MRV or verification claim. */
async function consumeJobs(db:Database,limit=100){
  let processed=0;
  while(processed<limit){
    const found=await db.transaction(async tx=>{
      const job=(await tx.query('SELECT id FROM jobs WHERE processed_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1')).rows[0];
      if(!job)return false;
      await tx.query('UPDATE jobs SET processed_at=now() WHERE id=$1',[job.id]);
      return true;
    });
    if(!found)break;processed++;
  }
  return processed;
}
async function heartbeat(db:Database,health:HealthState,ok:boolean){
  await db.query(`INSERT INTO worker_heartbeat(name,started_at,beat_at,cycles,failures,last_result,last_error_code) VALUES ($1,to_timestamp($2::numeric/1000),now(),1,$3,$4,$5)
    ON CONFLICT(name) DO UPDATE SET started_at=EXCLUDED.started_at,beat_at=now(),cycles=worker_heartbeat.cycles+1,failures=worker_heartbeat.failures+$3,last_result=EXCLUDED.last_result,last_error_code=EXCLUDED.last_error_code`,
    [health.name,health.startedAt,ok?0:1,health.lastResult,health.lastErrorCode]);
}
/**
 * One iteration of the worker loop. It never throws: a failure is logged with a safe code, counted, recorded on the
 * heartbeat if the database still answers, and reported to the caller so the loop can back off and carry on.
 */
export async function workerCycle(deps:WorkerDeps):Promise<CycleOutcome>{
  const {db,chain,log,metrics,health}=deps,now=deps.now??Date.now,started=now();
  try{
    const cycle=await runChainCycle(db,chain,{log,...deps.cycle});
    const jobs=await consumeJobs(db);
    // The market step is isolated: a failure there is counted and logged, but chaining and proofs keep running.
    let market:SweepResult|undefined;
    if(deps.market){
      try{market=await marketSweep(db,{config:deps.market.config,state:deps.market.state,metrics,log,now});}
      catch(error){metrics.inc('greenchain_market_sweep_failures_total');log.error({code:errorCodeOf(error),...safeErrorFields(error)},'Market sweep failed');}
    }
    let integrity=await auditIntegrity(db);
    const everyMs=deps.fullVerifyEveryMs??0;
    const lastFull=integrity.fullVerifiedAt?Date.parse(integrity.fullVerifiedAt):0;
    if(everyMs>0&&integrity.status==='OK'&&now()>=health.nextFullVerifyAt&&now()-lastFull>=everyMs){
      try{
        const full=await verifyAuditFull(db);
        metrics.inc('greenchain_audit_full_verifications_total',{result:'ok'});
        log.info({events:full.sequence,pending:full.pending,confirmedAnchors:full.confirmedAnchors},'Full audit verification passed');
      }catch(error){
        metrics.inc('greenchain_audit_full_verifications_total',{result:'failed'});
        health.nextFullVerifyAt=now()+5*60_000;
        log.error({code:errorCodeOf(error),...safeErrorFields(error)},'Full audit verification failed');
      }
      integrity=await auditIntegrity(db);
    }
    const stats=await proofStats(db),pendingJobs=(await db.query('SELECT count(*)::int AS n FROM jobs WHERE processed_at IS NULL')).rows[0].n;
    for(const status of PROOF_STATUSES)metrics.set('greenchain_proofs',stats.byStatus[status]??0,{status});
    metrics.set('greenchain_proof_oldest_unfinished_age_seconds',stats.oldestUnfinishedSeconds);
    metrics.set('greenchain_audit_pending_events',integrity.pendingEvents);
    metrics.set('greenchain_audit_verification_lag_links',Number(integrity.behind));
    metrics.set('greenchain_audit_integrity_failed',integrity.status==='FAILED'?1:0);
    metrics.set('greenchain_audit_full_verification_age_seconds',integrity.fullVerifiedAt?Math.round((now()-Date.parse(integrity.fullVerifiedAt))/1000):-1);
    metrics.set('greenchain_jobs_pending',pendingJobs);
    if('error' in cycle&&cycle.error)metrics.inc('greenchain_proof_failures_total',{code:cycle.error});
    const halted=cycle.proof==='HALTED_INTEGRITY'||integrity.status==='FAILED';
    if(halted&&!health.integrityFailed)log.error({code:integrity.failureCode},'Audit integrity check failed; chaining and proof submission are halted until an operator investigates');
    health.integrityFailed=halted;health.lastSuccessAt=now();health.lastResult=cycle.proof;health.lastErrorCode=null;health.consecutiveFailures=0;
    metrics.inc('greenchain_worker_cycles_total',{result:halted?'halted':'ok'});
    metrics.set('greenchain_worker_cycle_duration_seconds',(now()-started)/1000);
    metrics.set('greenchain_worker_last_success_timestamp_seconds',Math.floor(now()/1000));
    metrics.set('greenchain_worker_consecutive_failures',0);
    await heartbeat(db,health,true);
    const idle=!(cycle.audit?.processed)&&jobs===0&&IDLE_RESULTS.has(cycle.proof)&&!market?.worked;
    log[idle?'debug':'info']({proof:cycle.proof,chained:cycle.audit?.processed??0,jobs},'Worker cycle');
    return {ok:true,idle,result:cycle.proof};
  }catch(error){
    const code=errorCodeOf(error);
    health.consecutiveFailures++;health.lastResult='ERROR';health.lastErrorCode=code;
    metrics.inc('greenchain_worker_cycles_total',{result:'error'});
    metrics.set('greenchain_worker_consecutive_failures',health.consecutiveFailures);
    log.error({code,consecutiveFailures:health.consecutiveFailures,...safeErrorFields(error)},'Worker cycle failed');
    await heartbeat(db,health,false).catch(()=>{});
    return {ok:false,idle:false,result:'ERROR',errorCode:code};
  }
}
/** How long the loop waits before the next cycle: quickly while there is work, a second when idle, exponentially (capped) after failures. */
export function nextSleepMs(outcome:CycleOutcome,consecutiveFailures:number):number{
  if(!outcome.ok)return Math.min(30_000,1000*2**Math.min(consecutiveFailures,5));
  return outcome.idle?1000:100;
}
