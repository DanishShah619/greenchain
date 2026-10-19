import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {appendAudit} from '../../audit/application/audit.js';
import type {Actor} from '../../capture/application/capture.js';
import {WorkflowError} from '../../../kernel/errors.js';
type CasePort=(db:Database,actor:Actor,id:string,lock:boolean)=>Promise<{caseVersion:number;evidenceDecisionId:string}>;
type CandidatePort=(db:Database,actor:Actor,id:string,runId:string)=>Promise<{run:Record<string,any>;selection:Record<string,any>}>;
type ApprovalPort=(db:Database,actor:Actor,id:string,runId:string,generation:number,reviewId:string)=>Promise<void>;
type IssuancePort=(db:Database,actor:Actor,run:Record<string,any>,reviewId:string)=>Promise<unknown>;
export async function review(db:Database,actor:Actor,id:string,runId:string,input:{decisionId:string;expectedGeneration:number;inputsHash:string;decision:'APPROVED'|'REJECTED';reason:string},ports:{case:CasePort;candidate:CandidatePort;approve:ApprovalPort;issue:IssuancePort}){
  if(actor.role!=='verifier')throw new WorkflowError('FORBIDDEN',403);
  const reason=input.reason.trim();if(reason.length<10)throw new WorkflowError('REASON_REQUIRED',422);
  const requestHash=createHash('sha256').update(JSON.stringify([id,runId,input.expectedGeneration,input.inputsHash,input.decision,reason])).digest('hex');
  return db.transaction(async tx=>{
    const pinned=await ports.case(tx,actor,id,true),{run,selection}=await ports.candidate(tx,actor,id,runId);
    if(run.actor_id===actor.id)throw new WorkflowError('SELF_REVIEW',403);
    const old=(await tx.query('SELECT * FROM demo_calculation_reviews WHERE id=$1',[input.decisionId])).rows[0];
    if(old){if(old.scenario_id!==actor.scenarioId||old.capture_id!==id||old.run_id!==runId||old.reviewer_id!==actor.id)throw new WorkflowError('NOT_FOUND',404);if(old.request_hash!==requestHash)throw new WorkflowError('KEY_REUSE');return {review:old,replayed:true};}
    if(run.inputs_hash!==input.inputsHash||run.inputs.caseVersion!==pinned.caseVersion||run.evidence_decision_id!==pinned.evidenceDecisionId)throw new WorkflowError('STALE_CALCULATION');
    if(!selection||selection.active_run_id!==runId||selection.generation!==input.expectedGeneration)throw new WorkflowError('STALE_CALCULATION');
    if(selection.approved_review_id)throw new WorkflowError('ALREADY_ISSUED');
    if((await tx.query('SELECT id FROM demo_calculation_reviews WHERE run_id=$1',[runId])).rows.length)throw new WorkflowError('CALCULATION_ALREADY_REVIEWED');
    if(input.decision==='APPROVED'&&run.outcome!=='CALCULATED')throw new WorkflowError('VISIT_REQUIRED',422);
    const decision=(await tx.query(`INSERT INTO demo_calculation_reviews(id,scenario_id,capture_id,run_id,reviewer_id,decision,reason,inputs_hash,generation,request_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[input.decisionId,actor.scenarioId,id,runId,actor.id,input.decision,reason,run.inputs_hash,input.expectedGeneration,requestHash])).rows[0];
    let issuance:unknown=null;
    if(input.decision==='APPROVED'){
      await ports.approve(tx,actor,id,runId,input.expectedGeneration,decision.id);
      issuance=await ports.issue(tx,actor,run,decision.id);
    }
    await appendAudit(tx,actor,id,'demo.calculation.reviewed',{runId,reviewId:decision.id,decision:input.decision,inputsHash:run.inputs_hash});
    return {review:decision,issuance,replayed:false};
  });
}
export async function status(db:Database,actor:Actor,id:string){return (await db.query('SELECT id,run_id,reviewer_id,decision,reason,inputs_hash,generation,created_at FROM demo_calculation_reviews WHERE scenario_id=$1 AND capture_id=$2 ORDER BY created_at,id',[actor.scenarioId,id])).rows;}
