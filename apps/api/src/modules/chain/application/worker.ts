import {randomUUID} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {WorkflowError,safeErrorFields} from '../../../kernel/errors.js';
import {silentLogger,type Logger} from '../../../kernel/logger.js';
import {appendAudit,auditIntegrity,chainAudit,digest,verifyAuditIncremental} from '../../audit/application/audit.js';
import type {ChainPort,Prepared,ProofIntent} from './port.js';
import {DEFAULT_POLICY,classifyChainError,retryDelaySeconds,withDeadline,type ChainPolicy} from './policy.js';
type Lease={owner:string;fence:string};
export async function claimSigner(db:Database,owner=randomUUID(),leaseSeconds=DEFAULT_POLICY.leaseSeconds):Promise<Lease|undefined>{
  return db.transaction(async tx=>{
    const result=await tx.query(`UPDATE chain_worker_lease SET owner=$1,fence=fence+1,expires_at=now()+make_interval(secs=>$2) WHERE id=1 AND expires_at<=now() RETURNING fence`,[owner,leaseSeconds]);
    return result.rows[0]?{owner,fence:String(result.rows[0].fence)}:undefined;
  });
}
/** Extends a lease this process still holds. Called before every chain-port call so the lease only has to outlive one call. */
export async function renewLease(db:Database,lease:Lease,leaseSeconds=DEFAULT_POLICY.leaseSeconds){
  const renewed=await db.query(`UPDATE chain_worker_lease SET expires_at=now()+make_interval(secs=>$3) WHERE id=1 AND owner=$1 AND fence=$2 AND expires_at>now() RETURNING id`,[lease.owner,lease.fence,leaseSeconds]);
  if(!renewed.rows.length)throw new Error('CHAIN_LEASE_LOST');
}
export async function withFence<T>(db:Database,lease:Lease,work:(tx:Database)=>Promise<T>){
  return db.transaction(async tx=>{
    const valid=(await tx.query(`SELECT id FROM chain_worker_lease WHERE id=1 AND owner=$1 AND fence=$2 AND expires_at>now() FOR UPDATE`,[lease.owner,lease.fence])).rows.length;
    if(!valid)throw new Error('CHAIN_LEASE_LOST');return work(tx);
  });
}
function intent(row:Record<string,any>):ProofIntent{return {effectId:digest(['demo.credits.issued',row.event_id]),commitment:row.commitment,anchorSeq:String(row.anchor_seq),anchorHash:row.anchor_hash};}
function prepared(row:Record<string,any>):Prepared|undefined {
  if(!row.raw_transaction)return undefined;
  return {rawTransaction:row.raw_transaction,transactionHash:row.transaction_hash,nonce:Number(row.nonce),network:row.network,contractAddress:row.contract_address,signerAddress:row.signer_address};
}
export function proofCommitment(batch:Record<string,any>){
  return digest({version:1,namespace:'DEMO_ONLY',batchId:batch.id,calculationId:batch.run_id,reviewId:batch.review_id,inputsHash:batch.inputs_hash,vintage:batch.vintage,gross:String(batch.gross_co2e),buffer:String(batch.buffer_co2e),net:String(batch.net_co2e),creditCount:batch.credit_count,carry:String(batch.carry_co2e),creditIdRule:'DEMO-2026-{batchId}-{ordinal:6}'});
}
export async function queueProofs(db:Database){
  return db.transaction(async tx=>{
    const head=(await tx.query('SELECT head_seq,head_hash FROM audit_chain_state WHERE id=1 FOR UPDATE')).rows[0];
    // Anchor only a head the verification checkpoint already covers, so a proof never commits to an unverified chain. Not an error: wait for the next cycle.
    const integrity=(await tx.query('SELECT status,verified_seq FROM audit_integrity_state WHERE id=1')).rows[0];
    if(integrity.status!=='OK'||BigInt(integrity.verified_seq)<BigInt(head.head_seq))return 0;
    const events=(await tx.query(`SELECT e.id AS event_id,b.* FROM demo_registry_events e JOIN demo_issuance_batches b ON b.id=e.batch_id
      LEFT JOIN demo_chain_proofs p ON p.event_id=e.id WHERE p.event_id IS NULL AND e.event_type='demo.credits.issued'
      AND NOT EXISTS(SELECT 1 FROM audit_events a LEFT JOIN audit_chain_links l ON l.event_id=a.id WHERE a.scenario_id=b.scenario_id AND a.capture_id=b.capture_id AND l.event_id IS NULL)
      ORDER BY e.created_at,e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED`)).rows;
    if(BigInt(head.head_seq)===0n)return 0;
    for(const row of events)await tx.query(`INSERT INTO demo_chain_proofs(event_id,batch_id,commitment,anchor_seq,anchor_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[row.event_id,row.id,proofCommitment(row),head.head_seq,head.head_hash]);
    return events.length;
  });
}
export type CycleOptions={policy?:Partial<ChainPolicy>;log?:Logger;random?:()=>number};
/**
 * One pass of the proof worker: chain and verify the audit log, queue proofs, then advance at most one proof.
 * Failure handling is bounded and honest:
 *  - every chain-port call has a deadline, and the signer lease is renewed before it;
 *  - a failure stores a safe error code (never the raw message), increments failure_count and backs off with jitter;
 *  - a proof that never produced a transaction is parked as FAILED after maxFailures (an operator requeues it);
 *  - a proof that has a signed transaction is never abandoned automatically, because it may still land: it stays
 *    RECONCILING and keeps retrying with capped backoff.
 */
export async function runChainCycle(db:Database,port?:ChainPort,options:CycleOptions={}){
  const policy:ChainPolicy={...DEFAULT_POLICY,...options.policy},log=options.log??silentLogger,random=options.random??Math.random;
  let audit:Awaited<ReturnType<typeof chainAudit>>;
  try{audit=await chainAudit(db);}
  catch(error){
    // A finding has already been recorded as a sticky FAILED state; halt cleanly instead of crashing the worker.
    if(error instanceof WorkflowError&&error.code.startsWith('AUDIT_'))return {audit:undefined,integrity:await auditIntegrity(db),proof:'HALTED_INTEGRITY'};
    throw error;
  }
  const integrity=await verifyAuditIncremental(db);
  if(integrity.status==='FAILED')return {audit,integrity,proof:'HALTED_INTEGRITY'};
  await queueProofs(db);
  if(!port)return {audit,integrity,proof:'NOT_CONFIGURED'};
  const lease=await claimSigner(db,undefined,policy.leaseSeconds);if(!lease)return {audit,integrity,proof:'BUSY'};
  const call=async<T>(work:()=>Promise<T>)=>{await renewLease(db,lease,policy.leaseSeconds);return withDeadline(work(),policy.portCallDeadlineMs);};
  let row:Record<string,any>|undefined;
  try{
    row=await withFence(db,lease,async tx=>(await tx.query(`SELECT p.* FROM demo_chain_proofs p JOIN demo_registry_events e ON e.id=p.event_id
      WHERE p.status<>'FAILED' AND p.next_attempt_at<=now() AND (p.status<>'QUEUED' OR NOT EXISTS(SELECT 1 FROM demo_chain_proofs busy WHERE busy.transaction_hash IS NOT NULL AND busy.status NOT IN ('CONFIRMED','FAILED')))
      ORDER BY CASE WHEN p.raw_transaction IS NOT NULL AND p.status<>'CONFIRMED' THEN 0 WHEN p.status='CONFIRMED' THEN 1 ELSE 2 END,p.next_attempt_at,e.created_at,e.id LIMIT 1 FOR UPDATE OF p`)).rows[0]);
    if(!row)return {audit,integrity,proof:'IDLE'};
    if(row.network!==null&&(row.network!==port.identity.network||row.contract_address.toLowerCase()!==port.identity.contractAddress.toLowerCase()||row.signer_address.toLowerCase()!==port.identity.signerAddress.toLowerCase()))throw new Error('CHAIN_PREPARED_TRANSACTION_MISMATCH');
    const effect=intent(row);let signed=prepared(row);
    const observed=await call(()=>port.inspect(effect,signed));
    if(observed.status!=='ABSENT'){
      // An observation carrying an error code is an anomaly to watch (back off); a clean one is routine progress (poll).
      const anomalous=Boolean(observed.error),delay=anomalous?retryDelaySeconds(Number(row.failure_count)+1,policy,random):policy.pollSeconds;
      await withFence(db,lease,async tx=>{
        await tx.query(`UPDATE demo_chain_proofs SET status=$2,network=$3,contract_address=$4,signer_address=$5,transaction_hash=COALESCE($6,transaction_hash),block_number=$7,block_hash=$8,confirmations=$9,last_error=$10,attempts=attempts+1,
          failure_count=CASE WHEN $11::boolean THEN failure_count+1 ELSE 0 END,updated_at=now(),next_attempt_at=now()+make_interval(secs=>$12) WHERE event_id=$1`,
          [row!.event_id,observed.status,port.identity.network,port.identity.contractAddress,port.identity.signerAddress,observed.transactionHash??null,observed.blockNumber??null,observed.blockHash??null,observed.confirmations,observed.error??null,anomalous,delay]);
        await tx.query(`UPDATE demo_registry_events SET processed_at=CASE WHEN $2='CONFIRMED' THEN COALESCE(processed_at,now()) ELSE NULL END WHERE id=$1`,[row!.event_id,observed.status]);
      });
      if(observed.status!==row.status)log.info({eventId:row.event_id,from:row.status,to:observed.status,confirmations:observed.confirmations,...(observed.error?{code:observed.error}:{})},'Proof state changed');
      return {audit,integrity,proof:observed.status};
    }
    if(!signed){
      if(row.transaction_hash)throw new Error('CHAIN_ORIGINAL_TRANSACTION_REQUIRED');
      signed=await call(()=>port.prepare(effect));
      await withFence(db,lease,async tx=>{await tx.query(`UPDATE demo_chain_proofs SET status='PREPARED',network=$2,contract_address=$3,signer_address=$4,nonce=$5,raw_transaction=$6,transaction_hash=$7,updated_at=now() WHERE event_id=$1 AND raw_transaction IS NULL`,[row!.event_id,signed!.network,signed!.contractAddress,signed!.signerAddress,signed!.nonce,signed!.rawTransaction,signed!.transactionHash]);});
    }
    // Only durable bytes are broadcast. Timeout/crash retries use this same hash and nonce.
    await call(()=>port.submit(effect,signed!));
    await withFence(db,lease,async tx=>{await tx.query(`UPDATE demo_chain_proofs SET status='PENDING',attempts=attempts+1,failure_count=0,last_error=NULL,block_number=NULL,block_hash=NULL,confirmations=0,updated_at=now(),next_attempt_at=now()+make_interval(secs=>$2) WHERE event_id=$1`,[row!.event_id,Math.min(15,policy.pollSeconds)]);await tx.query('UPDATE demo_registry_events SET processed_at=NULL WHERE id=$1',[row!.event_id]);});
    log.info({eventId:row.event_id,from:row.status,to:'PENDING'},'Proof transaction submitted');
    return {audit,integrity,proof:'PENDING'};
  }catch(error){
    const code=classifyChainError(error);
    let proof='RETRY_PENDING',failureCount:number|undefined;
    if(row){
      failureCount=Number(row.failure_count)+1;
      const delay=retryDelaySeconds(failureCount,policy,random);
      try{
        const updated=await withFence(db,lease,async tx=>{
          // Status: a row with a signed transaction is never abandoned; one without is parked after maxFailures.
          const result=await tx.query(`UPDATE demo_chain_proofs SET status=CASE WHEN transaction_hash IS NOT NULL THEN 'RECONCILING' WHEN failure_count+1>=$3 THEN 'FAILED' ELSE 'QUEUED' END,
            failure_count=failure_count+1,attempts=attempts+1,last_error=$2,updated_at=now(),next_attempt_at=now()+make_interval(secs=>$4) WHERE event_id=$1 RETURNING status`,[row!.event_id,code,policy.maxFailures,delay]);
          await tx.query('UPDATE demo_registry_events SET processed_at=NULL WHERE id=$1',[row!.event_id]);
          return result.rows[0].status as string;
        });
        if(updated==='FAILED'){proof='FAILED';log.error({eventId:row.event_id,code,failureCount},'Proof parked as FAILED; an operator must requeue it');}
        else log.warn({eventId:row.event_id,code,failureCount,status:updated,retryInSeconds:delay,...safeErrorFields(error)},'Proof step failed; will retry');
      }catch(recordError){
        // The attempt itself failed and so did recording it (lease lost, database down). The next cycle re-derives state from the database.
        log.error({eventId:row.event_id,code,...safeErrorFields(recordError)},'Could not record a proof failure');
      }
    }
    return {audit,integrity,proof,error:code,failureCount};
  }finally{
    await db.query(`UPDATE chain_worker_lease SET owner=NULL,expires_at=now() WHERE id=1 AND owner=$1 AND fence=$2`,[lease.owner,lease.fence]);
  }
}
/**
 * Operator action: send a FAILED proof back to the queue. Only a proof that never produced a signed transaction can be
 * requeued; one with a transaction hash may already be on chain and must be reconciled by hand. The action is audited.
 */
export async function requeueProof(db:Database,eventId:string,operator='operator'){
  return db.transaction(async tx=>{
    const proof=(await tx.query(`SELECT p.event_id,p.status,p.transaction_hash,p.raw_transaction,b.scenario_id,b.capture_id FROM demo_chain_proofs p JOIN demo_issuance_batches b ON b.id=p.batch_id WHERE p.event_id=$1 FOR UPDATE OF p`,[eventId])).rows[0];
    if(!proof)throw new WorkflowError('PROOF_NOT_FOUND',404);
    if(proof.status!=='FAILED')throw new WorkflowError('PROOF_NOT_FAILED');
    if(proof.transaction_hash||proof.raw_transaction)throw new WorkflowError('PROOF_HAS_TRANSACTION');
    await tx.query(`UPDATE demo_chain_proofs SET status='QUEUED',failure_count=0,last_error=NULL,next_attempt_at=now(),updated_at=now() WHERE event_id=$1`,[eventId]);
    await appendAudit(tx,{id:operator,scenarioId:proof.scenario_id,role:'operator'},proof.capture_id,'chain.proof.requeued',{eventId});
    return {eventId,status:'QUEUED'};
  });
}
/** Counts for dashboards and alerts: proofs per status and the age of the oldest unfinished one. */
export async function proofStats(db:Database){
  const rows=(await db.query(`SELECT status,count(*)::int AS n,coalesce(max(extract(epoch FROM now()-created_at)),0)::float8 AS oldest FROM demo_chain_proofs GROUP BY status`)).rows;
  const byStatus:Record<string,number>={};let oldestUnfinished=0;
  for(const row of rows){byStatus[row.status]=row.n;if(row.status!=='CONFIRMED'&&row.status!=='FAILED')oldestUnfinished=Math.max(oldestUnfinished,Number(row.oldest));}
  return {byStatus,oldestUnfinishedSeconds:oldestUnfinished};
}
