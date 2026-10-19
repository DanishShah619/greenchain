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
  await db.query(`INSERT INTO audit_events(id,scenario_id,capture_id,actor_id,event_type,created_at,signed_record,row_mac) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[row.id,row.scenario_id,id,actor.id,action,row.created_at,JSON.stringify(signed),mac(db,signed)]);
  return row.id;
}
function checkedRecord(db:Database,row:Record<string,any>,signed:any,rowMac:string){
  if(!signed||!['AT_WRITE','LEGACY_BACKFILL'].includes(signed.origin)||canonical(record(db,row,signed.origin,signed.payloadHash))!==canonical(signed)||!equal(mac(db,signed),rowMac))throw new WorkflowError('AUDIT_INTEGRITY_FAILURE',503);
}
/** The state row lock fences every write and lives until commit. No RPC or lease expiry occurs inside this transaction. */
export async function chainAudit(db:Database,limit=100){
  return db.transaction(async tx=>{
    const state=(await tx.query('SELECT * FROM audit_chain_state WHERE id=1 FOR UPDATE')).rows[0];
    await verifyAudit(tx);
    let seq=BigInt(state.head_seq),head=state.head_hash;const fence=BigInt(state.fence)+1n;
    const rows=(await tx.query(`SELECT a.* FROM audit_events a LEFT JOIN audit_chain_links l ON l.event_id=a.id WHERE l.event_id IS NULL ORDER BY a.created_at,a.id LIMIT $1`,[limit])).rows;
    for(const row of rows){
      const signed=row.signed_record??record(tx,row,'LEGACY_BACKFILL',digest({})),rowMac=row.row_mac??mac(tx,signed);
      checkedRecord(tx,row,signed,rowMac);seq++;
      const next=digest({version:1,sequence:seq.toString(),previous:head,record:signed,mac:rowMac});
      await tx.query(`INSERT INTO audit_chain_links(chain_seq,event_id,previous_hash,head_hash,signed_record,row_mac,fence) VALUES($1,$2,$3,$4,$5,$6,$7)`,[seq.toString(),row.id,head,next,JSON.stringify(signed),rowMac,fence.toString()]);head=next;
    }
    await tx.query('UPDATE audit_chain_state SET head_seq=$1,head_hash=$2,fence=$3 WHERE id=1 AND fence=$4',[seq.toString(),head,fence.toString(),state.fence]);
    return {processed:rows.length,sequence:seq.toString(),headHash:head};
  });
}
export async function verifyAudit(db:Database){
  // One database statement supplies a consistent snapshot, even while the chainer commits.
  const rows=(await db.query(`SELECT s.head_seq,s.head_hash AS state_hash,a.*,l.chain_seq,l.previous_hash,l.head_hash,l.signed_record AS linked_record,l.row_mac AS linked_mac
    FROM audit_chain_state s LEFT JOIN audit_events a ON true LEFT JOIN audit_chain_links l ON l.event_id=a.id
    WHERE s.id=1 ORDER BY l.chain_seq NULLS LAST,a.created_at,a.id LIMIT 10001`)).rows;
  if(rows.length>10000)throw new WorkflowError('AUDIT_VERIFICATION_LIMIT',503);
  let seq=0n,head=GENESIS,legacy=0,pending=0;
  for(const row of rows){if(!row.id)continue;
    if(row.signed_record)checkedRecord(db,row,row.signed_record,row.row_mac);
    if(!row.chain_seq){pending++;continue;}
    const signed=row.linked_record;checkedRecord(db,row,signed,row.linked_mac);
    if(signed.origin==='AT_WRITE'&&(canonical(signed)!==canonical(row.signed_record)||row.linked_mac!==row.row_mac))throw new WorkflowError('AUDIT_INTEGRITY_FAILURE',503);
    seq++;const next=digest({version:1,sequence:seq.toString(),previous:head,record:signed,mac:row.linked_mac});
    if(BigInt(row.chain_seq)!==seq||row.previous_hash!==head||row.head_hash!==next)throw new WorkflowError('AUDIT_INTEGRITY_FAILURE',503);
    if(signed.origin==='LEGACY_BACKFILL')legacy++;head=next;
  }
  if(rows[0]&&(BigInt(rows[0].head_seq)!==seq||rows[0].state_hash!==head))throw new WorkflowError('AUDIT_INTEGRITY_FAILURE',503);
  const anchors=(await db.query(`SELECT p.anchor_seq,p.anchor_hash,l.head_hash FROM demo_chain_proofs p LEFT JOIN audit_chain_links l ON l.chain_seq=p.anchor_seq WHERE p.status='CONFIRMED' LIMIT 10001`)).rows;
  if(anchors.length>10000||anchors.some(a=>a.head_hash!==a.anchor_hash))throw new WorkflowError('AUDIT_ANCHOR_MISMATCH',503);
  return {status:'VERIFIED' as const,sequence:seq.toString(),headHash:head,pending,legacyBackfilled:legacy,confirmedAnchors:anchors.length,checkedAt:new Date().toISOString(),limitation:'Unchained or unwitnessed tail deletion requires an independent witness. Backfilled rows were first signed during chaining.'};
}
