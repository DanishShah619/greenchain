import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import type {Actor} from '../../capture/application/capture.js';
import {WorkflowError} from '../../../kernel/errors.js';
export const GENESIS='0'.repeat(64);
export function canonical(value:any):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function key(db:Database){if(!db.auditKey||db.auditKey.length!==32)throw new Error('Audit signing key is required');return db.auditKey;}
function mac(db:Database,value:unknown){return createHmac('sha256',key(db)).update(canonical(value)).digest('hex');}
function equal(a:string,b:string){return /^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function record(db:Database,row:Record<string,any>,origin:string,payloadHash:string){
  return {version:1,keyVersion:1,eventId:row.id,scope:mac(db,['scope',row.scenario_id]),entity:mac(db,['entity',row.scenario_id,row.capture_id]),actor:mac(db,['actor',row.scenario_id,row.actor_id]),action:row.event_type,createdAt:new Date(row.created_at).toISOString(),payloadHash,origin};
}
/** Only pseudonymous IDs and safe reference fingerprints belong in facts; never farmer labels or evidence bytes. */
export async function appendAudit(db:Database,actor:Actor,id:string,action:string,facts:unknown={}){
  const row={id:randomUUID(),scenario_id:actor.scenarioId,capture_id:id,actor_id:actor.id,event_type:action,created_at:new Date().toISOString()};
  const signed=record(db,row,'AT_WRITE',digest(facts));
  // A trigger queues the new event for chaining in this same transaction.
  await db.query(`INSERT INTO audit_events(id,scenario_id,capture_id,actor_id,event_type,created_at,signed_record,row_mac) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[row.id,row.scenario_id,id,actor.id,action,row.created_at,JSON.stringify(signed),mac(db,signed)]);
  return row.id;
}
function checkedRecord(db:Database,row:Record<string,any>,signed:any,rowMac:string){
  if(!signed||!['AT_WRITE','LEGACY_BACKFILL'].includes(signed.origin)||canonical(record(db,row,signed.origin,signed.payloadHash))!==canonical(signed)||!equal(mac(db,signed),rowMac))throw new WorkflowError('AUDIT_INTEGRITY_FAILURE',503);
}
const integrityFailure=(code='AUDIT_INTEGRITY_FAILURE')=>new WorkflowError(code,503);
/** Only genuine integrity findings flip the sticky FAILED state; a timeout or dropped connection must not. */
const isIntegrityFinding=(error:unknown):error is WorkflowError=>error instanceof WorkflowError&&error.code.startsWith('AUDIT_');
/** Commits independently of any failed work, so the finding survives the rollback of the transaction that detected it. */
async function recordFailure(db:Database,error:WorkflowError,failedSeq?:bigint){
  await db.transaction(async tx=>{
    await tx.query(`UPDATE audit_integrity_state SET status='FAILED',failure_code=$1,failed_seq=$2,checked_at=now() WHERE id=1 AND status='OK'`,[error.code,failedSeq===undefined?null:failedSeq.toString()]);
  });
}
/** Chain links joined to their events, in chain order; the shape every verifier checks. */
const LINKS=`SELECT a.*,l.chain_seq,l.previous_hash,l.head_hash,l.signed_record AS linked_record,l.row_mac AS linked_mac
  FROM audit_chain_links l JOIN audit_events a ON a.id=l.event_id WHERE l.chain_seq>$1 AND l.chain_seq<=$3 ORDER BY l.chain_seq LIMIT $2`;
type Cursor={seq:bigint;head:string;legacy:number};
/** Verifies signed metadata, MACs and hash continuity of consecutive links, starting after `cursor`. */
function verifyLinkRows(db:Database,rows:Record<string,any>[],cursor:Cursor):Cursor{
  let {seq,head,legacy}=cursor;
  for(const row of rows){
    if(row.signed_record)checkedRecord(db,row,row.signed_record,row.row_mac);
    const signed=row.linked_record;checkedRecord(db,row,signed,row.linked_mac);
    if(signed.origin==='AT_WRITE'&&(canonical(signed)!==canonical(row.signed_record)||row.linked_mac!==row.row_mac))throw integrityFailure();
    seq++;const next=digest({version:1,sequence:seq.toString(),previous:head,record:signed,mac:row.linked_mac});
    if(BigInt(row.chain_seq)!==seq||row.previous_hash!==head||row.head_hash!==next)throw integrityFailure();
    if(signed.origin==='LEGACY_BACKFILL')legacy++;
    head=next;
  }
  return {seq,head,legacy};
}
/**
 * The state row lock fences every write and lives until commit. No RPC or lease expiry occurs inside this transaction.
 * Cost is proportional to the batch, not to history: pending events come from a queue, and the existing chain is trusted
 * through the verification checkpoint (see verifyAuditIncremental) plus an O(1) check that the stored head is the last link.
 */
export async function chainAudit(db:Database,limit=100){
  try{
    return await db.transaction(async tx=>{
      const state=(await tx.query('SELECT * FROM audit_chain_state WHERE id=1 FOR UPDATE')).rows[0];
      if((await tx.query(`SELECT status FROM audit_integrity_state WHERE id=1`)).rows[0].status==='FAILED')throw integrityFailure();
      let seq=BigInt(state.head_seq),head=state.head_hash;const fence=BigInt(state.fence)+1n;
      const tip=seq===0n?GENESIS:(await tx.query('SELECT head_hash FROM audit_chain_links WHERE chain_seq=$1',[seq.toString()])).rows[0]?.head_hash;
      if(tip!==head)throw integrityFailure();
      const rows=(await tx.query(`SELECT a.* FROM audit_chain_queue q JOIN audit_events a ON a.id=q.event_id ORDER BY q.created_at,q.event_id LIMIT $1`,[limit])).rows;
      for(const row of rows){
        const signed=row.signed_record??record(tx,row,'LEGACY_BACKFILL',digest({})),rowMac=row.row_mac??mac(tx,signed);
        checkedRecord(tx,row,signed,rowMac);seq++;
        const next=digest({version:1,sequence:seq.toString(),previous:head,record:signed,mac:rowMac});
        await tx.query(`INSERT INTO audit_chain_links(chain_seq,event_id,previous_hash,head_hash,signed_record,row_mac,fence) VALUES($1,$2,$3,$4,$5,$6,$7)`,[seq.toString(),row.id,head,next,JSON.stringify(signed),rowMac,fence.toString()]);head=next;
      }
      if(rows.length)await tx.query('DELETE FROM audit_chain_queue WHERE event_id=ANY($1::uuid[])',[rows.map(row=>row.id)]);
      await tx.query('UPDATE audit_chain_state SET head_seq=$1,head_hash=$2,fence=$3 WHERE id=1 AND fence=$4',[seq.toString(),head,fence.toString(),state.fence]);
      return {processed:rows.length,sequence:seq.toString(),headHash:head};
    });
  }catch(error){
    if(isIntegrityFinding(error))await recordFailure(db,error);
    throw error;
  }
}
export type Integrity={status:'OK'|'FAILED';failureCode:string|null;verifiedSequence:string;headSequence:string;behind:string;pendingEvents:number;checkedAt:string|null;fullVerifiedAt:string|null};
/** Constant-time read of where verification stands. Safe for the worker heartbeat and metrics; deliberately not exposed to tenants. */
export async function auditIntegrity(db:Database):Promise<Integrity>{
  const s=(await db.query(`SELECT i.status,i.failure_code,i.verified_seq,i.checked_at,i.full_verified_at,c.head_seq,(SELECT count(*)::int FROM audit_chain_queue) AS pending
    FROM audit_integrity_state i, audit_chain_state c WHERE i.id=1 AND c.id=1`)).rows[0];
  return {status:s.status,failureCode:s.failure_code,verifiedSequence:String(s.verified_seq),headSequence:String(s.head_seq),behind:(BigInt(s.head_seq)-BigInt(s.verified_seq)).toString(),pendingEvents:s.pending,
    checkedAt:s.checked_at?new Date(s.checked_at).toISOString():null,fullVerifiedAt:s.full_verified_at?new Date(s.full_verified_at).toISOString():null};
}
/** Checks every confirmed anchor the checkpoint has now passed, once. */
async function verifyNewAnchors(tx:Database,verifiedSeq:bigint){
  const anchors=(await tx.query(`SELECT p.event_id,p.anchor_hash,l.head_hash FROM demo_chain_proofs p LEFT JOIN audit_chain_links l ON l.chain_seq=p.anchor_seq
    WHERE p.status='CONFIRMED' AND p.anchor_verified_at IS NULL AND p.anchor_seq<=$1 LIMIT 500`,[verifiedSeq.toString()])).rows;
  if(anchors.some(a=>a.head_hash!==a.anchor_hash))throw integrityFailure('AUDIT_ANCHOR_MISMATCH');
  if(anchors.length)await tx.query('UPDATE demo_chain_proofs SET anchor_verified_at=now() WHERE event_id=ANY($1::uuid[])',[anchors.map(a=>a.event_id)]);
}
/**
 * Verifies only the links added since the stored checkpoint, then advances it. Cost is proportional to the new links.
 * Returns the resulting integrity state and never throws for a verification finding: a finding records a sticky FAILED
 * state that halts chaining and proof queueing. It cannot see tampering with rows already behind the checkpoint; that is
 * what verifyAuditFull is for.
 */
export async function verifyAuditIncremental(db:Database,options:{batchSize?:number;maxBatches?:number}={}):Promise<Integrity>{
  const batchSize=options.batchSize??1000,maxBatches=options.maxBatches??20;
  for(let batch=0;batch<maxBatches;batch++){
    // Mutated inside the callback, so held in an object (a bare `let` would be narrowed to `undefined` afterwards).
    const outcome:{finding?:{error:WorkflowError;seq:bigint};more:boolean}={more:false};
    await db.transaction(async tx=>{
      const s=(await tx.query('SELECT * FROM audit_integrity_state WHERE id=1 FOR UPDATE')).rows[0];
      if(s.status==='FAILED')return;
      const from=BigInt(s.verified_seq),head=BigInt((await tx.query('SELECT head_seq FROM audit_chain_state WHERE id=1')).rows[0].head_seq);
      const rows=from<head?(await tx.query(LINKS,[from.toString(),batchSize,head.toString()])).rows:[];
      let cursor:Cursor={seq:from,head:s.verified_hash,legacy:0};
      try{
        cursor=verifyLinkRows(tx,rows,cursor);
        // A complete walk must end exactly at the stored head.
        if(cursor.seq===head){
          const state=(await tx.query('SELECT head_hash FROM audit_chain_state WHERE id=1')).rows[0];
          if(state.head_hash!==cursor.head)throw integrityFailure();
        }
        await verifyNewAnchors(tx,cursor.seq);
      }catch(error){
        if(!isIntegrityFinding(error))throw error;
        outcome.finding={error,seq:cursor.seq+1n};return;
      }
      await tx.query('UPDATE audit_integrity_state SET verified_seq=$1,verified_hash=$2,checked_at=now() WHERE id=1',[cursor.seq.toString(),cursor.head]);
      outcome.more=rows.length===batchSize&&cursor.seq<head;
    });
    if(outcome.finding){await recordFailure(db,outcome.finding.error,outcome.finding.seq);break;}
    if(!outcome.more)break;
  }
  return auditIntegrity(db);
}
export type FullAudit={status:'VERIFIED';sequence:string;headHash:string;pending:number;legacyBackfilled:number;confirmedAnchors:number;checkedAt:string};
/**
 * Re-verifies the whole log from genesis in keyset batches (bounded memory, no event-count ceiling), including events
 * not yet chained and every confirmed anchor. O(history): run it off the request path, periodically or on demand.
 * This is the only check that detects tampering with rows already behind the incremental checkpoint.
 */
export async function verifyAuditFull(db:Database,options:{batchSize?:number}={}):Promise<FullAudit>{
  const batchSize=options.batchSize??2000;
  try{
    const state=(await db.query('SELECT head_seq,head_hash FROM audit_chain_state WHERE id=1')).rows[0],headSeq=BigInt(state.head_seq);
    let cursor:Cursor={seq:0n,head:GENESIS,legacy:0};
    while(cursor.seq<headSeq){
      const rows=(await db.query(LINKS,[cursor.seq.toString(),batchSize,headSeq.toString()])).rows;
      if(!rows.length)throw integrityFailure();
      cursor=verifyLinkRows(db,rows,cursor);
    }
    if(cursor.head!==state.head_hash)throw integrityFailure();
    // Events waiting to be chained must carry a valid signature, and every event must be chained or queued (none silently dropped).
    let pending=0,after='00000000-0000-0000-0000-000000000000';
    for(;;){
      const rows=(await db.query(`SELECT a.* FROM audit_chain_queue q JOIN audit_events a ON a.id=q.event_id WHERE q.event_id>$1 ORDER BY q.event_id LIMIT $2`,[after,batchSize])).rows;
      if(!rows.length)break;
      for(const row of rows)if(row.signed_record)checkedRecord(db,row,row.signed_record,row.row_mac);
      pending+=rows.length;after=rows[rows.length-1].id;
    }
    const orphans=(await db.query(`SELECT count(*)::int AS n FROM audit_events a LEFT JOIN audit_chain_links l ON l.event_id=a.id LEFT JOIN audit_chain_queue q ON q.event_id=a.id WHERE l.event_id IS NULL AND q.event_id IS NULL`)).rows[0].n;
    if(orphans>0)throw integrityFailure();
    let confirmedAnchors=0,anchorAfter='00000000-0000-0000-0000-000000000000';
    for(;;){
      const anchors=(await db.query(`SELECT p.event_id,p.anchor_hash,l.head_hash FROM demo_chain_proofs p LEFT JOIN audit_chain_links l ON l.chain_seq=p.anchor_seq WHERE p.status='CONFIRMED' AND p.event_id>$1 ORDER BY p.event_id LIMIT $2`,[anchorAfter,batchSize])).rows;
      if(!anchors.length)break;
      if(anchors.some(a=>a.head_hash!==a.anchor_hash))throw integrityFailure('AUDIT_ANCHOR_MISMATCH');
      confirmedAnchors+=anchors.length;anchorAfter=anchors[anchors.length-1].event_id;
    }
    await db.transaction(async tx=>{
      await tx.query('SELECT 1 FROM audit_integrity_state WHERE id=1 FOR UPDATE');
      await tx.query(`UPDATE audit_integrity_state SET checked_at=now(),full_verified_at=now(),full_verified_seq=$1,
        verified_seq=GREATEST(verified_seq,$1),verified_hash=CASE WHEN $1>verified_seq THEN $2 ELSE verified_hash END WHERE id=1 AND status='OK'`,[headSeq.toString(),cursor.head]);
    });
    return {status:'VERIFIED',sequence:headSeq.toString(),headHash:cursor.head,pending,legacyBackfilled:cursor.legacy,confirmedAnchors,checkedAt:new Date().toISOString()};
  }catch(error){
    if(isIntegrityFinding(error))await recordFailure(db,error);
    throw error;
  }
}
export const AUDIT_LIMITATION='Verification runs in the background and is checkpointed; an unchained or unwitnessed tail deletion requires an independent witness. Backfilled rows were first signed during chaining.';
export type CaseAudit={status:'VERIFIED'|'PENDING'|'FAILED';checkedAt:string|null;caseEvents:{total:number;committed:number;verified:number};caseHead:{sequence:string;hash:string}|null;limitation:string};
/**
 * What a case's owner or reviewer may see: the state of that case's own events only. It deliberately carries no global
 * sequence, head hash or counts, which would reveal other scenarios' activity, and it never walks the log.
 */
export async function caseAudit(db:Database,scenarioId:string,captureId:string):Promise<CaseAudit>{
  const s=(await db.query('SELECT status,verified_seq,checked_at FROM audit_integrity_state WHERE id=1')).rows[0];
  const counts=(await db.query(`SELECT count(*)::int AS total,count(l.chain_seq)::int AS committed,(count(*) FILTER (WHERE l.chain_seq<=$3))::int AS verified,max(l.chain_seq) AS last_seq
    FROM audit_events a LEFT JOIN audit_chain_links l ON l.event_id=a.id WHERE a.scenario_id=$1 AND a.capture_id=$2`,[scenarioId,captureId,String(s.verified_seq)])).rows[0];
  const head=counts.last_seq===null||counts.last_seq===undefined?undefined:(await db.query('SELECT chain_seq,head_hash FROM audit_chain_links WHERE chain_seq=$1',[String(counts.last_seq)])).rows[0];
  const status=s.status==='FAILED'?'FAILED':counts.total>0&&counts.verified===counts.total?'VERIFIED':'PENDING';
  return {status,checkedAt:s.checked_at?new Date(s.checked_at).toISOString():null,caseEvents:{total:counts.total,committed:counts.committed,verified:counts.verified},
    caseHead:head?{sequence:String(head.chain_seq),hash:head.head_hash}:null,limitation:AUDIT_LIMITATION};
}
