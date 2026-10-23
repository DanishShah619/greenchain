import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
import {withScenarioLock} from '../../market/application/lock.js';
import {CLOCK_MAX_OFFSET_SECONDS,CLOCK_MAX_STEP_SECONDS} from '../domain/config.js';
/**
 * Two named time domains (docs/23 P6). Simulated time (holdback, run dates, retry schedule, the idempotency window) is the
 * real clock plus the scenario's demo offset; leases and worker polling use real time only, so a clock jump never expires a
 * live lease.
 */
export type SimTime={real:Date;sim:Date;offsetSeconds:number};
export async function simNow(tx:Database,scenarioId:string):Promise<SimTime>{
  const r=(await tx.query(`SELECT r AS real,r+make_interval(secs=>o) AS sim,o FROM (SELECT clock_timestamp() AS r,coalesce((SELECT offset_seconds FROM demo_clock WHERE scenario_id=$1),0) AS o) x`,[scenarioId])).rows[0];
  return {real:new Date(r.real),sim:new Date(r.sim),offsetSeconds:Number(r.o)};
}
/**
 * Presenter control (docs/23 P7): advance by compare-and-set, so a repeated click with a stale offset cannot advance twice.
 * Taken under the scenario lock, so a sale never sees the clock move halfway through its fulfilment.
 */
export async function advanceClock(db:Database,scenarioId:string,input:{expectedOffsetSeconds:number;advanceSeconds:number}):Promise<SimTime>{
  const {expectedOffsetSeconds:expected,advanceSeconds:step}=input;
  if(!Number.isInteger(step)||step<1||step>CLOCK_MAX_STEP_SECONDS||!Number.isInteger(expected)||expected<0)throw new WorkflowError('VALIDATION_FAILED',422);
  return withScenarioLock(db,scenarioId,async tx=>{
    await tx.query('INSERT INTO demo_clock(scenario_id,offset_seconds) VALUES ($1,0) ON CONFLICT (scenario_id) DO NOTHING',[scenarioId]);
    const current=Number((await tx.query('SELECT offset_seconds FROM demo_clock WHERE scenario_id=$1',[scenarioId])).rows[0].offset_seconds);
    if(current!==expected)throw new WorkflowError('CLOCK_CONFLICT',409);
    if(current+step>CLOCK_MAX_OFFSET_SECONDS)throw new WorkflowError('CLOCK_LIMIT',409);
    await tx.query('UPDATE demo_clock SET offset_seconds=$2 WHERE scenario_id=$1',[scenarioId,current+step]);
    return simNow(tx,scenarioId);
  });
}
