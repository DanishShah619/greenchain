import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {appendAudit} from '../../audit/application/audit.js';
import type {Actor} from '../../capture/application/capture.js';
import {WorkflowError} from '../../../kernel/errors.js';
import {METHODOLOGY,PARAMETERS,ASSUMPTIONS,PRESETS,computeDemo,type Preset} from '../domain/demo.js';
export type DemoCaseInputs={caseVersion:number;evidenceDecisionId:string;areaHectares:string;snapshot:unknown};
export type DemoCasePort=(db:Database,actor:Actor,id:string,lock:boolean)=>Promise<DemoCaseInputs>;
export function canonical(value:any):string{
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export async function calculate(db:Database,actor:Actor,id:string,input:{requestId:string;expectedVersion:number;preset:Preset},casePort:DemoCasePort){
  if(actor.role!=='agent')throw new WorkflowError('FORBIDDEN',403);
  return db.transaction(async tx=>{
    const namespace=await tx.query('SELECT scenario_id FROM demo_namespaces WHERE scenario_id=$1',[actor.scenarioId]);
    if(!namespace.rows.length)throw new WorkflowError('DEMO_SCOPE_ONLY',403);
    const pinned=await casePort(tx,actor,id,true);
    const requestHash=digest([id,input.preset,input.expectedVersion]);
    const old=(await tx.query(`SELECT r.request_hash,c.* FROM demo_calculation_receipts r JOIN demo_calculation_runs c ON c.id=r.run_id
      WHERE r.scenario_id=$1 AND r.actor_id=$2 AND r.request_id=$3`,[actor.scenarioId,actor.id,input.requestId])).rows[0];
    if(old){if(old.request_hash!==requestHash)throw new WorkflowError('KEY_REUSE');return {run:old,replayed:true};}
    if(pinned.caseVersion!==input.expectedVersion)throw new WorkflowError('VERSION_CONFLICT');
    const result=computeDemo(pinned.areaHectares,input.preset);
    const inputs={namespace:'DEMO_ONLY',methodology:METHODOLOGY,parameterSet:PARAMETERS,parameters:ASSUMPTIONS,preset:input.preset,fixture:PRESETS[input.preset],...pinned,areaHectares:result.trace.areaHectares,origins:['DEMO_BOUNDARY','FIXTURE_SCENARIO']};
    const inputsHash=digest(inputs);
    let run=(await tx.query('SELECT * FROM demo_calculation_runs WHERE scenario_id=$1 AND capture_id=$2 AND inputs_hash=$3',[actor.scenarioId,id,inputsHash])).rows[0];
    const replayed=Boolean(run);
    if(!run){
      const selected=(await tx.query('SELECT approved_review_id FROM demo_calculation_state WHERE scenario_id=$1 AND capture_id=$2 FOR UPDATE',[actor.scenarioId,id])).rows[0];
      if(selected?.approved_review_id)throw new WorkflowError('CALCULATION_LOCKED');
      run=(await tx.query(`INSERT INTO demo_calculation_runs(id,scenario_id,capture_id,actor_id,evidence_decision_id,methodology_version,parameter_version,preset,inputs_hash,inputs,result,outcome)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[randomUUID(),actor.scenarioId,id,actor.id,pinned.evidenceDecisionId,METHODOLOGY,PARAMETERS,input.preset,inputsHash,JSON.stringify(inputs),JSON.stringify(result),result.outcome])).rows[0];
      await tx.query(`INSERT INTO demo_calculation_state(scenario_id,capture_id,active_run_id) VALUES ($1,$2,$3)
        ON CONFLICT(scenario_id,capture_id) DO UPDATE SET active_run_id=excluded.active_run_id,generation=demo_calculation_state.generation+1`,[actor.scenarioId,id,run.id]);
      await appendAudit(tx,actor,id,'demo.calculation.recorded',{runId:run.id,inputsHash});
    }
    await tx.query('INSERT INTO demo_calculation_receipts(scenario_id,actor_id,request_id,request_hash,run_id) VALUES ($1,$2,$3,$4,$5)',[actor.scenarioId,actor.id,input.requestId,requestHash,run.id]);
    return {run,replayed};
  });
}
export async function list(db:Database,actor:Actor,id:string,authorize:(db:Database,actor:Actor,id:string)=>Promise<unknown>){
  await authorize(db,actor,id);
  return {methodology:METHODOLOGY,parameterVersion:PARAMETERS,assumptions:ASSUMPTIONS,presets:PRESETS,selection:(await db.query('SELECT active_run_id,generation,approved_review_id FROM demo_calculation_state WHERE scenario_id=$1 AND capture_id=$2',[actor.scenarioId,id])).rows[0],runs:(await db.query('SELECT * FROM demo_calculation_runs WHERE scenario_id=$1 AND capture_id=$2 ORDER BY created_at DESC,id LIMIT 20',[actor.scenarioId,id])).rows};
}
export async function candidate(db:Database,actor:Actor,id:string,runId:string){
  const run=(await db.query('SELECT * FROM demo_calculation_runs WHERE scenario_id=$1 AND capture_id=$2 AND id=$3',[actor.scenarioId,id,runId])).rows[0];
  if(!run)throw new WorkflowError('NOT_FOUND',404);
  const selection=(await db.query('SELECT * FROM demo_calculation_state WHERE scenario_id=$1 AND capture_id=$2 FOR UPDATE',[actor.scenarioId,id])).rows[0];
  return {run,selection};
}
export async function approveCandidate(db:Database,actor:Actor,id:string,runId:string,generation:number,reviewId:string){
  const updated=await db.query(`UPDATE demo_calculation_state SET approved_review_id=$5 WHERE scenario_id=$1 AND capture_id=$2 AND active_run_id=$3 AND generation=$4 AND approved_review_id IS NULL RETURNING generation`,[actor.scenarioId,id,runId,generation,reviewId]);
  if(!updated.rows.length)throw new WorkflowError('STALE_CALCULATION');
}
export async function submitCandidate(db:Database,actor:Actor,id:string,runId:string,input:{requestId:string;expectedGeneration:number;inputsHash:string},casePort:DemoCasePort){
  if(actor.role!=='agent')throw new WorkflowError('FORBIDDEN',403);
  return db.transaction(async tx=>{
    const pinned=await casePort(tx,actor,id,true),{run,selection}=await candidate(tx,actor,id,runId);
    const requestHash=digest([id,runId,input.expectedGeneration,input.inputsHash]);
    const receipt=(await tx.query('SELECT request_hash,result FROM demo_candidate_receipts WHERE scenario_id=$1 AND actor_id=$2 AND request_id=$3',[actor.scenarioId,actor.id,input.requestId])).rows[0];
    if(receipt){if(receipt.request_hash!==requestHash)throw new WorkflowError('KEY_REUSE');return receipt.result;}
    if(selection?.approved_review_id)throw new WorkflowError('CALCULATION_LOCKED');
    if(!selection||selection.generation!==input.expectedGeneration||run.inputs_hash!==input.inputsHash||run.inputs.caseVersion!==pinned.caseVersion||run.evidence_decision_id!==pinned.evidenceDecisionId)throw new WorkflowError('STALE_CALCULATION');
    if((await tx.query('SELECT id FROM demo_calculation_reviews WHERE run_id=$1',[runId])).rows.length)throw new WorkflowError('CALCULATION_ALREADY_REVIEWED');
    const changed=selection.active_run_id!==runId;
    if(changed){
      await tx.query('UPDATE demo_calculation_state SET active_run_id=$3,generation=generation+1 WHERE scenario_id=$1 AND capture_id=$2',[actor.scenarioId,id,runId]);
      await appendAudit(tx,actor,id,'demo.calculation.submitted',{runId,inputsHash:run.inputs_hash,generation:selection.generation+1});
    }
    const result={activeRunId:runId,generation:selection.generation+(changed?1:0)};
    await tx.query('INSERT INTO demo_candidate_receipts(scenario_id,actor_id,request_id,request_hash,result) VALUES ($1,$2,$3,$4,$5)',[actor.scenarioId,actor.id,input.requestId,requestHash,JSON.stringify(result)]);
    return result;
  });
}
