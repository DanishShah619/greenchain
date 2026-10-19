import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {validateBoundary,type Boundary} from '@greenchain/geometry';
import type {Database} from '../../../kernel/database.js';
import type {Actor} from '../../capture/application/capture.js';
import {WorkflowError} from '../domain/errors.js';
import {appendAudit} from '../../audit/application/audit.js';
export const CHUNK_SIZE=262144;
const digest=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const institution=(actor:Actor)=>actor.institutionId??'demo-institution';
export async function requireCase(db:Database,actor:Actor,id:string,lock=false){
  const row=(await db.query(`SELECT r.*,c.actor_id,c.institution_id,c.onboarding,c.farmer_label,c.village,c.area_hectares AS declared_area
    FROM review_cases r JOIN captures c ON c.scenario_id=r.scenario_id AND c.event_id=r.capture_id
    WHERE r.scenario_id=$1 AND r.capture_id=$2 ${lock?'FOR UPDATE OF r':''}`,[actor.scenarioId,id])).rows[0];
  if(!row)throw new WorkflowError('NOT_FOUND',404);
  if(actor.role==='agent'){
    if(row.actor_id!==actor.id||row.institution_id!==institution(actor))throw new WorkflowError('NOT_FOUND',404);
  }else if(actor.role==='verifier'){
    const mandate=await db.query('SELECT 1 FROM review_mandates WHERE user_id=$1 AND scenario_id=$2 AND institution_id=$3',[actor.id,actor.scenarioId,row.institution_id]);
    if(!mandate.rows.length)throw new WorkflowError('NOT_FOUND',404);
  }else throw new WorkflowError('FORBIDDEN',403);
  return row;
}
function agent(actor:Actor){if(actor.role!=='agent')throw new WorkflowError('FORBIDDEN',403);}
function editable(row:Record<string,any>){if(row.state!=='DRAFT')throw new WorkflowError('CASE_LOCKED');}
async function audit(db:Database,actor:Actor,id:string,event:string,facts:unknown={}){await appendAudit(db,actor,id,event,facts);}
async function bump(db:Database,actor:Actor,id:string){await db.query('UPDATE review_cases SET version=version+1 WHERE scenario_id=$1 AND capture_id=$2',[actor.scenarioId,id]);}
export async function saveBoundary(db:Database,actor:Actor,id:string,input:{requestId:string;expectedVersion:number;boundary:Boundary}){
  agent(actor);let result:ReturnType<typeof validateBoundary>;
  try{result=validateBoundary(input.boundary);}catch{throw new WorkflowError('INVALID_BOUNDARY',422);}
  const fingerprint=digest(JSON.stringify(result.boundary));
  return db.transaction(async tx=>{
    const row=await requireCase(tx,actor,id,true);
    const receipt=(await tx.query('SELECT fingerprint,result FROM boundary_receipts WHERE scenario_id=$1 AND capture_id=$2 AND request_id=$3',[actor.scenarioId,id,input.requestId])).rows[0];
    if(receipt){if(receipt.fingerprint!==fingerprint)throw new WorkflowError('KEY_REUSE');return receipt.result;}
    editable(row);if(row.version!==input.expectedVersion)throw new WorkflowError('VERSION_CONFLICT');
    await tx.query(`INSERT INTO plots(scenario_id,capture_id,boundary,area_hectares) VALUES ($1,$2,$3,$4)
      ON CONFLICT(scenario_id,capture_id) DO UPDATE SET boundary=excluded.boundary,area_hectares=excluded.area_hectares`,[actor.scenarioId,id,JSON.stringify(result.boundary),result.areaHectares]);
    await bump(tx,actor,id);await audit(tx,actor,id,'plot.boundary.saved',{requestId:input.requestId,boundaryFingerprint:fingerprint,version:row.version+1});
    const output={...result,version:row.version+1};
    await tx.query('INSERT INTO boundary_receipts(scenario_id,capture_id,request_id,fingerprint,result) VALUES ($1,$2,$3,$4,$5)',[actor.scenarioId,id,input.requestId,fingerprint,JSON.stringify(output)]);
    return output;
  });
}
export type UploadInput={uploadId:string;slot:'land_rights'|'plot_photo';mime:'image/png'|'image/jpeg';size:number;sha256:string;filename:string};
export async function beginUpload(db:Database,actor:Actor,id:string,input:UploadInput){
  agent(actor);
  return db.transaction(async tx=>{
    // Scenario lock makes quota checks and reservations atomic across captures.
    await tx.query('SELECT id FROM scenarios WHERE id=$1 FOR UPDATE',[actor.scenarioId]);
    const row=await requireCase(tx,actor,id,true);
    const old=(await tx.query('SELECT * FROM evidence_uploads WHERE id=$1',[input.uploadId])).rows[0];
    if(old){
      if(old.scenario_id!==actor.scenarioId||old.capture_id!==id||old.actor_id!==actor.id)throw new WorkflowError('NOT_FOUND',404);
      if(old.slot!==input.slot||old.mime!==input.mime||old.size!==input.size||old.sha256!==input.sha256||old.filename!==input.filename)throw new WorkflowError('KEY_REUSE');
      return {uploadId:old.id,status:old.status,chunkSize:CHUNK_SIZE,received:(await tx.query('SELECT chunk_index FROM evidence_chunks WHERE upload_id=$1 ORDER BY chunk_index',[old.id])).rows.map(r=>r.chunk_index)};
    }
    editable(row);
    if((await tx.query('SELECT id FROM evidence_uploads WHERE scenario_id=$1 AND capture_id=$2 AND slot=$3',[actor.scenarioId,id,input.slot])).rows.length)throw new WorkflowError('SLOT_ALREADY_RESERVED');
    const quota=(await tx.query('SELECT coalesce(sum(size+coalesce(octet_length(preview_data),0)),0)::bigint AS size,count(*)::int AS n FROM evidence_uploads WHERE scenario_id=$1',[actor.scenarioId])).rows[0];
    if(Number(quota.size)+input.size>67108864||quota.n>=100)throw new WorkflowError('EVIDENCE_QUOTA',422);
    await tx.query('INSERT INTO evidence_uploads(id,scenario_id,capture_id,actor_id,slot,mime,size,sha256,filename) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[input.uploadId,actor.scenarioId,id,actor.id,input.slot,input.mime,input.size,input.sha256,input.filename]);
    await bump(tx,actor,id);await audit(tx,actor,id,'evidence.upload.started',{uploadId:input.uploadId,slot:input.slot,sha256:input.sha256});
    return {uploadId:input.uploadId,status:'UPLOADING',chunkSize:CHUNK_SIZE,received:[]};
  });
}
async function ownedUpload(db:Database,actor:Actor,uploadId:string){
  const upload=(await db.query('SELECT * FROM evidence_uploads WHERE id=$1 AND scenario_id=$2',[uploadId,actor.scenarioId])).rows[0];
  if(!upload)throw new WorkflowError('NOT_FOUND',404);
  await requireCase(db,actor,upload.capture_id);
  return upload;
}
export async function uploadChunk(db:Database,actor:Actor,uploadId:string,index:number,encoded:string){
  agent(actor);
  const data=Buffer.from(encoded,'base64');
  if(data.toString('base64')!==encoded)throw new WorkflowError('INVALID_CHUNK',422);
  return db.transaction(async tx=>{
    const upload=await ownedUpload(tx,actor,uploadId),row=await requireCase(tx,actor,upload.capture_id,true);
    const count=Math.ceil(upload.size/CHUNK_SIZE);
    if(index>=count||data.length!==Math.min(CHUNK_SIZE,upload.size-index*CHUNK_SIZE))throw new WorkflowError('INVALID_CHUNK',422);
    const sha=digest(data),old=(await tx.query('SELECT sha256 FROM evidence_chunks WHERE upload_id=$1 AND chunk_index=$2',[uploadId,index])).rows[0];
    if(old){if(old.sha256!==sha)throw new WorkflowError('KEY_REUSE');return {index,received:true};}
    editable(row);if(upload.status!=='UPLOADING')throw new WorkflowError('UPLOAD_COMPLETE');
    await tx.query('INSERT INTO evidence_chunks(upload_id,chunk_index,data,sha256) VALUES ($1,$2,$3,$4)',[uploadId,index,data,sha]);
    return {index,received:true};
  });
}
export async function completeUpload(db:Database,actor:Actor,uploadId:string){
  agent(actor);const upload=await ownedUpload(db,actor,uploadId);
  if(upload.status==='COMPLETE')return {uploadId,status:'COMPLETE'};
  const chunks=(await db.query('SELECT chunk_index,data FROM evidence_chunks WHERE upload_id=$1 ORDER BY chunk_index',[uploadId])).rows;
  if(chunks.length!==Math.ceil(upload.size/CHUNK_SIZE)||chunks.some((chunk,i)=>chunk.chunk_index!==i))throw new WorkflowError('MISSING_CHUNKS');
  const original=Buffer.concat(chunks.map(chunk=>Buffer.from(chunk.data)));
  if(original.length!==upload.size||digest(original)!==upload.sha256)throw new WorkflowError('HASH_MISMATCH',422);
  let preview:Buffer;
  try{
    const image=sharp(original,{limitInputPixels:12000000,failOn:'warning'}),metadata=await image.metadata();
    if(metadata.format!==(upload.mime==='image/png'?'png':'jpeg')||(metadata.pages??1)!==1)throw new Error('Unsupported image');
    preview=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).png().toBuffer();
  }catch{throw new WorkflowError('INVALID_IMAGE',422);}
  return db.transaction(async tx=>{
    await tx.query('SELECT id FROM scenarios WHERE id=$1 FOR UPDATE',[actor.scenarioId]);
    const row=await requireCase(tx,actor,upload.capture_id,true);
    const current=(await tx.query('SELECT status FROM evidence_uploads WHERE id=$1',[uploadId])).rows[0];
    if(current.status==='COMPLETE')return {uploadId,status:'COMPLETE'};
    editable(row);
    const quota=(await tx.query('SELECT coalesce(sum(size+coalesce(octet_length(preview_data),0)),0)::bigint AS size FROM evidence_uploads WHERE scenario_id=$1',[actor.scenarioId])).rows[0];
    if(Number(quota.size)+preview.length>67108864)throw new WorkflowError('EVIDENCE_QUOTA',422);
    await tx.query("UPDATE evidence_uploads SET status='COMPLETE',preview_data=$2 WHERE id=$1",[uploadId,preview]);
    await bump(tx,actor,upload.capture_id);await audit(tx,actor,upload.capture_id,'evidence.validated',{uploadId,sha256:upload.sha256,previewHash:digest(preview),version:row.version+1});
    return {uploadId,status:'COMPLETE'};
  });
}
async function requirements(db:Database,actor:Actor,id:string){
  const plot=(await db.query('SELECT boundary,area_hectares FROM plots WHERE scenario_id=$1 AND capture_id=$2',[actor.scenarioId,id])).rows[0];
  const evidence=(await db.query('SELECT id,slot,status,sha256,filename,size FROM evidence_uploads WHERE scenario_id=$1 AND capture_id=$2 ORDER BY slot',[actor.scenarioId,id])).rows;
  const missing:string[]=[];if(!plot)missing.push('boundary');
  for(const slot of ['land_rights','plot_photo'])if(!evidence.some(e=>e.slot===slot&&e.status==='COMPLETE'))missing.push(slot);
  return {plot,evidence,missing};
}
export async function detail(db:Database,actor:Actor,id:string){
  const row=await requireCase(db,actor,id),inputs=await requirements(db,actor,id);
  const decision=(await db.query('SELECT decision,reason,reviewer_id,created_at FROM review_decisions WHERE scenario_id=$1 AND capture_id=$2',[actor.scenarioId,id])).rows[0];
  return {case:row,...inputs,decision};
}
export async function submit(db:Database,actor:Actor,id:string,expectedVersion:number){
  agent(actor);return db.transaction(async tx=>{
    const row=await requireCase(tx,actor,id,true);
    if(row.state!=='DRAFT')return {state:row.state,version:row.version};
    if(row.version!==expectedVersion)throw new WorkflowError('VERSION_CONFLICT');
    if(!row.onboarding)throw new WorkflowError('ONBOARDING_REQUIRED',422);
    const inputs=await requirements(tx,actor,id);if(inputs.missing.length)throw new WorkflowError('MISSING_EVIDENCE',422);
    await tx.query("UPDATE review_cases SET state='SUBMITTED',version=version+1,submitted_at=now() WHERE scenario_id=$1 AND capture_id=$2",[actor.scenarioId,id]);
    await audit(tx,actor,id,'case.submitted',{version:row.version+1});return {state:'SUBMITTED',version:row.version+1};
  });
}
export async function queue(db:Database,actor:Actor){
  if(actor.role!=='verifier')throw new WorkflowError('FORBIDDEN',403);
  return {cases:(await db.query(`SELECT r.capture_id,r.state,r.version,r.submitted_at,c.farmer_label,c.village,
    (SELECT count(*)::int FROM evidence_uploads e WHERE e.scenario_id=r.scenario_id AND e.capture_id=r.capture_id AND e.status='COMPLETE') AS complete_slots,
    EXISTS(SELECT 1 FROM plots p WHERE p.scenario_id=r.scenario_id AND p.capture_id=r.capture_id) AS has_boundary
    FROM review_cases r JOIN captures c ON c.scenario_id=r.scenario_id AND c.event_id=r.capture_id
    WHERE r.scenario_id=$1 AND EXISTS(SELECT 1 FROM review_mandates m WHERE m.user_id=$2 AND m.scenario_id=r.scenario_id AND m.institution_id=c.institution_id)
    ORDER BY CASE r.state WHEN 'SUBMITTED' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END,r.submitted_at NULLS LAST,r.capture_id LIMIT 50`,[actor.scenarioId,actor.id])).rows};
}
export async function decide(db:Database,actor:Actor,id:string,input:{decisionId:string;expectedVersion:number;decision:'EVIDENCE_APPROVED'|'REJECTED';reason:string}){
  if(actor.role!=='verifier')throw new WorkflowError('FORBIDDEN',403);
  const reason=input.reason.trim();if(reason.length<10)throw new WorkflowError('REASON_REQUIRED',422);
  const fingerprint=digest(JSON.stringify([id,input.expectedVersion,input.decision,reason]));
  return db.transaction(async tx=>{
    const row=await requireCase(tx,actor,id,true);
    if(row.actor_id===actor.id)throw new WorkflowError('SELF_REVIEW',403);
    const old=(await tx.query('SELECT * FROM review_decisions WHERE id=$1',[input.decisionId])).rows[0];
    if(old){if(old.scenario_id!==actor.scenarioId||old.capture_id!==id||old.reviewer_id!==actor.id)throw new WorkflowError('NOT_FOUND',404);if(old.fingerprint!==fingerprint)throw new WorkflowError('KEY_REUSE');return {state:old.decision,replayed:true};}
    if(row.state!=='SUBMITTED')throw new WorkflowError('CASE_NOT_SUBMITTED');
    if(row.version!==input.expectedVersion)throw new WorkflowError('VERSION_CONFLICT');
    const inputs=await requirements(tx,actor,id);if(inputs.missing.length)throw new WorkflowError('MISSING_EVIDENCE',422);
    const snapshot={onboarding:row.onboarding,plot:inputs.plot,evidence:inputs.evidence.map(e=>({id:e.id,slot:e.slot,sha256:e.sha256})),caseVersion:row.version};
    await tx.query('INSERT INTO review_decisions(id,scenario_id,capture_id,reviewer_id,decision,reason,fingerprint,snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[input.decisionId,actor.scenarioId,id,actor.id,input.decision,reason,fingerprint,JSON.stringify(snapshot)]);
    await tx.query('UPDATE review_cases SET state=$3,version=version+1 WHERE scenario_id=$1 AND capture_id=$2',[actor.scenarioId,id,input.decision]);
    await audit(tx,actor,id,'evidence.review.decided',{decisionId:input.decisionId,decision:input.decision,version:row.version+1});return {state:input.decision,replayed:false};
  });
}
export async function preview(db:Database,actor:Actor,uploadId:string){
  const upload=await ownedUpload(db,actor,uploadId);
  if(upload.status!=='COMPLETE')throw new WorkflowError('EVIDENCE_INCOMPLETE',409);
  return Buffer.from(upload.preview_data);
}
// Read port for the synthetic demonstration; production MRV does not consume reviewer decisions.
export async function approvedDemoInputs(db:Database,actor:Actor,id:string,lock:boolean){
  const row=await requireCase(db,actor,id,lock);
  if(row.state!=='EVIDENCE_APPROVED')throw new WorkflowError('EVIDENCE_NOT_APPROVED',422);
  const decision=(await db.query('SELECT id,snapshot FROM review_decisions WHERE scenario_id=$1 AND capture_id=$2 AND decision=$3',[actor.scenarioId,id,'EVIDENCE_APPROVED'])).rows[0];
  const current=await requirements(db,actor,id);
  if(!decision||current.missing.length)throw new WorkflowError('STALE_EVIDENCE');
  const snapshot=decision.snapshot;
  if(JSON.stringify(row.onboarding)!==JSON.stringify(snapshot.onboarding))throw new WorkflowError('STALE_EVIDENCE');
  const proofHashes=(value:any[])=>value.map(item=>`${item.id}:${item.slot}:${item.sha256}`).sort().join('|');
  if(JSON.stringify(current.plot?.boundary)!==JSON.stringify(snapshot.plot?.boundary)||String(current.plot?.area_hectares)!==String(snapshot.plot?.area_hectares)||proofHashes(current.evidence)!==proofHashes(snapshot.evidence))throw new WorkflowError('STALE_EVIDENCE');
  return {caseVersion:row.version,evidenceDecisionId:decision.id,areaHectares:String(snapshot.plot.area_hectares),snapshot};
}
