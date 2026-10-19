import {randomUUID} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {appendAudit,caseAudit} from '../../audit/application/audit.js';
import type {Actor} from '../../capture/application/capture.js';
import {WorkflowError} from '../../../kernel/errors.js';
import {splitIssuance} from '../domain/quantities.js';
// Internal port: invoked inside the exact-calculation review transaction, never from buyer-supplied amounts.
export async function issue(db:Database,actor:Actor,run:Record<string,any>,reviewId:string){
  if(actor.role!=='verifier'||run.namespace!=='DEMO_ONLY'||run.outcome!=='CALCULATED')throw new WorkflowError('DEMO_ISSUANCE_BLOCKED',422);
  if(!(await db.query('SELECT scenario_id FROM demo_namespaces WHERE scenario_id=$1',[actor.scenarioId])).rows.length)throw new WorkflowError('DEMO_SCOPE_ONLY',403);
  const basis=(await db.query(`SELECT r.id FROM demo_calculation_reviews r JOIN demo_calculation_state s ON s.scenario_id=r.scenario_id AND s.capture_id=r.capture_id
    WHERE r.id=$1 AND r.scenario_id=$2 AND r.capture_id=$3 AND r.run_id=$4 AND r.decision='APPROVED' AND s.approved_review_id=r.id AND s.active_run_id=r.run_id`,[reviewId,actor.scenarioId,run.capture_id,run.id])).rows[0];
  if(!basis)throw new WorkflowError('ISSUANCE_BASIS_REQUIRED');
  const existing=(await db.query('SELECT * FROM demo_issuance_batches WHERE scenario_id=$1 AND capture_id=$2',[actor.scenarioId,run.capture_id])).rows[0];
  if(existing){if(existing.run_id!==run.id||existing.review_id!==reviewId)throw new WorkflowError('ALREADY_ISSUED');return existing;}
  let quantities:ReturnType<typeof splitIssuance>;try{quantities=splitIssuance(run.result);}catch{throw new WorkflowError('INVALID_CALCULATION',422);}
  const batch=(await db.query(`INSERT INTO demo_issuance_batches(id,scenario_id,capture_id,run_id,review_id,vintage,gross_co2e,buffer_co2e,net_co2e,credit_count,carry_co2e,inputs_hash)
    VALUES ($1,$2,$3,$4,$5,2026,$6,$7,$8,$9,$10,$11) RETURNING *`,[randomUUID(),actor.scenarioId,run.capture_id,run.id,reviewId,quantities.gross,quantities.buffer,quantities.net,quantities.credits,quantities.carry,run.inputs_hash])).rows[0];
  if(quantities.credits>0)await db.query(`INSERT INTO demo_credits(id,batch_id,ordinal)
    SELECT 'DEMO-2026-'||$1::text||'-'||lpad(n::text,6,'0'),$1::uuid,n FROM generate_series(1,$2::integer) AS n`,[batch.id,quantities.credits]);
  await appendAudit(db,actor,run.capture_id,'demo.issuance.recorded',{batchId:batch.id,reviewId,runId:run.id,inputsHash:run.inputs_hash,creditCount:quantities.credits});
  await db.query('INSERT INTO demo_registry_events(id,batch_id,event_type,payload) VALUES ($1,$2,$3,$4)',[randomUUID(),batch.id,'demo.credits.issued',JSON.stringify({namespace:'DEMO_ONLY',batchId:batch.id,calculationId:run.id,reviewId,inputsHash:run.inputs_hash,creditCount:quantities.credits})]);
  return batch;
}
export async function inventory(db:Database,actor:Actor,id:string,after:number,authorize:(db:Database,actor:Actor,id:string)=>Promise<unknown>){
  await authorize(db,actor,id);
  const batch=(await db.query('SELECT * FROM demo_issuance_batches WHERE scenario_id=$1 AND capture_id=$2',[actor.scenarioId,id])).rows[0];
  if(!batch)return {batch:null,credits:[],nextAfter:null};
  const credits=(await db.query('SELECT id,ordinal,quantity,state FROM demo_credits WHERE batch_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT 50',[batch.id,after])).rows;
  const last=credits.at(-1)?.ordinal??after;
  const proof=(await db.query(`SELECT status,commitment,anchor_seq,anchor_hash,network,contract_address,transaction_hash,block_number,confirmations,last_error FROM demo_chain_proofs WHERE batch_id=$1`,[batch.id])).rows[0]??null;
  const audit=await caseAudit(db,actor.scenarioId,id);
  const configured=Boolean(process.env.AMOY_RPC_URL&&process.env.AMOY_CONTRACT_ADDRESS&&process.env.AMOY_SIGNER_KEY_FILE&&process.env.AMOY_CONTRACT_CODE_HASH);
  return {batch,credits,nextAfter:last<batch.credit_count?last:null,proofStatus:!configured&&(!proof||proof.status==='QUEUED')?'NOT_CONFIGURED':proof?.status??'QUEUED',proof,audit};
}
