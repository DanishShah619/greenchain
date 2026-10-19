import {randomUUID} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {chainAudit,digest,verifyAudit} from '../../audit/application/audit.js';
import type {ChainPort,Prepared,ProofIntent} from './port.js';
type Lease={owner:string;fence:string};
export async function claimSigner(db:Database,owner=randomUUID()):Promise<Lease|undefined>{
  return db.transaction(async tx=>{
    const result=await tx.query(`UPDATE chain_worker_lease SET owner=$1,fence=fence+1,expires_at=now()+interval '90 seconds' WHERE id=1 AND expires_at<=now() RETURNING fence`,[owner]);
    return result.rows[0]?{owner,fence:String(result.rows[0].fence)}:undefined;
  });
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
  await verifyAudit(db);
  return db.transaction(async tx=>{
    const head=(await tx.query('SELECT head_seq,head_hash FROM audit_chain_state WHERE id=1 FOR UPDATE')).rows[0];
    const events=(await tx.query(`SELECT e.id AS event_id,b.* FROM demo_registry_events e JOIN demo_issuance_batches b ON b.id=e.batch_id
      LEFT JOIN demo_chain_proofs p ON p.event_id=e.id WHERE p.event_id IS NULL AND e.event_type='demo.credits.issued'
      AND NOT EXISTS(SELECT 1 FROM audit_events a LEFT JOIN audit_chain_links l ON l.event_id=a.id WHERE a.scenario_id=b.scenario_id AND a.capture_id=b.capture_id AND l.event_id IS NULL)
      ORDER BY e.created_at,e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED`)).rows;
    if(BigInt(head.head_seq)===0n)return 0;
    for(const row of events)await tx.query(`INSERT INTO demo_chain_proofs(event_id,batch_id,commitment,anchor_seq,anchor_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[row.event_id,row.id,proofCommitment(row),head.head_seq,head.head_hash]);
    return events.length;
  });
}
const allowedErrors=new Set(['CHAIN_NETWORK_MISMATCH','CHAIN_CONTRACT_MISMATCH','CHAIN_WRITER_MISMATCH','CHAIN_GAS_LIMIT','CHAIN_FEE_LIMIT','CHAIN_PREPARED_TRANSACTION_MISMATCH','CHAIN_ORIGINAL_TRANSACTION_REQUIRED','CHAIN_LEASE_LOST']);
export async function runChainCycle(db:Database,port?:ChainPort){
  const audit=await chainAudit(db);await queueProofs(db);
  if(!port)return {audit,proof:'NOT_CONFIGURED'};
  const lease=await claimSigner(db);if(!lease)return {audit,proof:'BUSY'};
  let row:Record<string,any>|undefined;
  try{
    row=await withFence(db,lease,async tx=>(await tx.query(`SELECT p.* FROM demo_chain_proofs p JOIN demo_registry_events e ON e.id=p.event_id
      WHERE p.next_attempt_at<=now() AND (p.status<>'QUEUED' OR NOT EXISTS(SELECT 1 FROM demo_chain_proofs busy WHERE busy.transaction_hash IS NOT NULL AND busy.status<>'CONFIRMED'))
      ORDER BY CASE WHEN p.raw_transaction IS NOT NULL AND p.status<>'CONFIRMED' THEN 0 WHEN p.status='CONFIRMED' THEN 1 ELSE 2 END,p.next_attempt_at,e.created_at,e.id LIMIT 1 FOR UPDATE OF p`)).rows[0]);
    if(!row)return {audit,proof:'IDLE'};
    if(row.network!==null&&(row.network!==port.identity.network||row.contract_address.toLowerCase()!==port.identity.contractAddress.toLowerCase()||row.signer_address.toLowerCase()!==port.identity.signerAddress.toLowerCase()))throw new Error('CHAIN_PREPARED_TRANSACTION_MISMATCH');
    const effect=intent(row);let signed=prepared(row);
    const observed=await port.inspect(effect,signed);
    if(observed.status!=='ABSENT'){
      await withFence(db,lease,async tx=>{
        await tx.query(`UPDATE demo_chain_proofs SET status=$2,network=$3,contract_address=$4,signer_address=$5,transaction_hash=COALESCE($6,transaction_hash),block_number=$7,block_hash=$8,confirmations=$9,last_error=$10,attempts=attempts+1,updated_at=now(),next_attempt_at=now()+interval '30 seconds' WHERE event_id=$1`,[row!.event_id,observed.status,port.identity.network,port.identity.contractAddress,port.identity.signerAddress,observed.transactionHash??null,observed.blockNumber??null,observed.blockHash??null,observed.confirmations,observed.error??null]);
        await tx.query(`UPDATE demo_registry_events SET processed_at=CASE WHEN $2='CONFIRMED' THEN COALESCE(processed_at,now()) ELSE NULL END WHERE id=$1`,[row!.event_id,observed.status]);
      });
      return {audit,proof:observed.status};
    }
    if(!signed){
      if(row.transaction_hash)throw new Error('CHAIN_ORIGINAL_TRANSACTION_REQUIRED');
      signed=await port.prepare(effect);
      await withFence(db,lease,async tx=>{await tx.query(`UPDATE demo_chain_proofs SET status='PREPARED',network=$2,contract_address=$3,signer_address=$4,nonce=$5,raw_transaction=$6,transaction_hash=$7,updated_at=now() WHERE event_id=$1 AND raw_transaction IS NULL`,[row!.event_id,signed!.network,signed!.contractAddress,signed!.signerAddress,signed!.nonce,signed!.rawTransaction,signed!.transactionHash]);});
    }
    // Only durable bytes are broadcast. Timeout/crash retries use this same hash and nonce.
    await withFence(db,lease,async()=>{});
    await port.submit(effect,signed);
    await withFence(db,lease,async tx=>{await tx.query(`UPDATE demo_chain_proofs SET status='PENDING',attempts=attempts+1,last_error=NULL,block_number=NULL,block_hash=NULL,confirmations=0,updated_at=now(),next_attempt_at=now()+interval '15 seconds' WHERE event_id=$1`,[row!.event_id]);await tx.query('UPDATE demo_registry_events SET processed_at=NULL WHERE id=$1',[row!.event_id]);});
    return {audit,proof:'PENDING'};
  }catch(error){
    const message=error instanceof Error&&allowedErrors.has(error.message)?error.message:'CHAIN_RPC_UNAVAILABLE';
    if(row)await withFence(db,lease,async tx=>{await tx.query(`UPDATE demo_chain_proofs SET status=CASE WHEN transaction_hash IS NULL THEN 'QUEUED' ELSE 'RECONCILING' END,attempts=attempts+1,last_error=$2,updated_at=now(),next_attempt_at=now()+interval '30 seconds' WHERE event_id=$1`,[row!.event_id,message]);await tx.query('UPDATE demo_registry_events SET processed_at=NULL WHERE id=$1',[row!.event_id]);}).catch(()=>{});
    return {audit,proof:'RETRY_PENDING',error:message};
  }finally{
    await db.query(`UPDATE chain_worker_lease SET owner=NULL,expires_at=now() WHERE id=1 AND owner=$1 AND fence=$2`,[lease.owner,lease.fence]);
  }
}
