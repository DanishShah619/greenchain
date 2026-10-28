import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
import {appendAudit} from '../../audit/application/audit.js';
import type {Actor} from '../../capture/application/capture.js';
import {certificateHash,newCertificateNumber} from '../domain/certificate.js';
import {DEMO_CERTIFICATE_LABEL,type CertificateView} from './certificates.js';
import {withNewWorkLock} from './lock.js';
import {DEMO_LABEL,groupLabel,ownedOrder,requireBuyer} from './orders.js';
/**
 * Credit retirement (docs/25 T1-T7). A buyer retires SOLD credits it bought, for a reporting period, and receives one frozen,
 * hashed retirement certificate per retirement. RETIRED is terminal. No money moves: the ledger, journals and payouts are untouched.
 */
export type RetireInput={requestId:string;orderId?:string;count?:number;creditIds?:string[];reportingPeriod:string;purpose?:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `FY2026-27` (consecutive years) or a calendar year `2026`. */
export const REPORTING_PERIOD=/^(FY20[2-9][0-9]-[0-9]{2}|20[2-9][0-9])$/;
/** Shown publicly on the certificate, so letters, digits and basic punctuation only: no markup. */
export const PURPOSE=/^[A-Za-z0-9 ,.()&:/'-]{1,120}$/;
export const CREDIT_ID=/^[A-Za-z0-9-]{1,64}$/;
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bad=(code:string)=>new WorkflowError(code,400);
export function validPeriod(period:unknown):period is string{
  if(typeof period!=='string'||!REPORTING_PERIOD.test(period))return false;
  if(!period.startsWith('FY'))return true;
  return (Number(period.slice(2,6))+1)%100===Number(period.slice(7));
}
function validate(input:RetireInput){
  if(typeof input.requestId!=='string'||!UUID.test(input.requestId))throw bad('INVALID_REQUEST_ID');
  if(!validPeriod(input.reportingPeriod))throw bad('INVALID_REPORTING_PERIOD');
  if(input.purpose!==undefined&&(typeof input.purpose!=='string'||!PURPOSE.test(input.purpose)))throw bad('INVALID_PURPOSE');
  const byCount=input.orderId!==undefined,byIds=input.creditIds!==undefined;
  if(byCount===byIds)throw bad('INVALID_SELECTION');
  if(byCount&&(!Number.isInteger(input.count)||input.count!<1||input.count!>100))throw bad('INVALID_COUNT');
  if(byIds&&(!Array.isArray(input.creditIds)||input.creditIds.length<1||input.creditIds.length>100||new Set(input.creditIds).size!==input.creditIds.length
    ||input.creditIds.some(id=>typeof id!=='string'||!CREDIT_ID.test(id))))throw bad('INVALID_CREDITS');
}
const certificateView=(r:any):CertificateView=>({number:r.number,content:r.content,contentSha256:r.content_sha256,issuedAt:new Date(r.issued_at).toISOString()});
async function retirementView(tx:Database,row:any,replayed:boolean){
  const credits=(await tx.query('SELECT credit_id FROM demo_retirement_items WHERE retirement_id=$1 ORDER BY credit_id',[row.id])).rows.map(r=>r.credit_id as string);
  const certificate=(await tx.query('SELECT * FROM demo_retirement_certificates WHERE retirement_id=$1',[row.id])).rows[0];
  return {namespace:'DEMO_ONLY' as const,label:DEMO_LABEL,replayed,
    retirement:{id:row.id as string,creditIds:credits,creditCount:row.credit_count as number,reportingPeriod:row.reporting_period as string,
      purpose:(row.purpose??null) as string|null,createdAt:new Date(row.created_at).toISOString()},
    certificate:certificateView(certificate)};
}
/** The SOLD credits to retire, locked in ascending id order. Throws without writing anything when the selection is not retirable. */
async function select(tx:Database,actor:Actor,input:RetireInput):Promise<string[]>{
  if(input.orderId!==undefined){
    const order=await ownedOrder(tx,actor,input.orderId,false);
    if(order.state!=='FULFILLED')throw new WorkflowError('ORDER_NOT_FULFILLED');
    const rows=(await tx.query(`SELECT c.id,c.state FROM demo_credits c JOIN demo_ledger_entries e ON e.credit_id=c.id WHERE e.order_id=$1 ORDER BY c.id FOR UPDATE OF c`,[order.id])).rows;
    const sold=rows.filter(r=>r.state==='SOLD').map(r=>r.id as string);
    if(sold.length<input.count!)throw new WorkflowError('NOT_ENOUGH_CREDITS');
    return sold.slice(0,input.count);
  }
  const ids=[...input.creditIds!].sort();
  // Owned means bought: a ledger row of one of this buyer's FULFILLED orders in this scenario. Anything else is not found.
  const rows=(await tx.query(`SELECT c.id,c.state FROM demo_credits c JOIN demo_ledger_entries e ON e.credit_id=c.id JOIN demo_orders o ON o.id=e.order_id
    WHERE c.id=ANY($1::text[]) AND o.scenario_id=$2 AND o.buyer_id=$3 AND o.state='FULFILLED' ORDER BY c.id FOR UPDATE OF c`,[ids,actor.scenarioId,actor.id])).rows;
  if(rows.length!==ids.length)throw new WorkflowError('NOT_FOUND',404);
  if(rows.some(r=>r.state!=='SOLD'))throw new WorkflowError('CREDIT_NOT_RETIRABLE');
  return ids;
}
/** The certificate content, from stored rows only. Purchase certificates are listed when the source order has one. */
async function buildContent(tx:Database,retirement:any,creditIds:string[],number:string,issuedAt:Date){
  const rows=(await tx.query(`SELECT c.id,b.vintage,e.payee_group_id::text AS payee,pc.number AS purchase
    FROM demo_credits c JOIN demo_issuance_batches b ON b.id=c.batch_id JOIN demo_ledger_entries e ON e.credit_id=c.id
    LEFT JOIN demo_certificates pc ON pc.order_id=e.order_id WHERE c.id=ANY($1::text[]) ORDER BY c.id`,[creditIds])).rows;
  if(rows.length!==creditIds.length)throw new WorkflowError('CERTIFICATE_MISMATCH');
  const groups=new Map<string,number>();
  for(const r of rows){const label=groupLabel(r.payee);groups.set(label,(groups.get(label)??0)+1);}
  return {
    schema:'greenchain-demo-retirement-certificate-v1',kind:'RETIREMENT',namespace:'DEMO_ONLY',label:DEMO_CERTIFICATE_LABEL,number,issuedAt:issuedAt.toISOString(),
    buyer:{account:retirement.buyer_id as string},reportingPeriod:retirement.reporting_period as string,purpose:(retirement.purpose??null) as string|null,
    quantity:rows.length,
    credits:rows.map(r=>({id:r.id as string,tonnes:'1',vintage:Number(r.vintage),group:groupLabel(r.payee)})),
    groups:[...groups].map(([group,credits])=>({group,credits})).sort((a,b)=>a.group<b.group?-1:a.group>b.group?1:0),
    purchaseCertificates:[...new Set(rows.filter(r=>r.purchase).map(r=>r.purchase as string))].sort(),
    verification:{path:`/api/v1/certificates/${number}`},
  };
}
/**
 * POST /orders/:id/retirements (by count) and POST /retirements (by credit ids). One transaction under the scenario lock:
 * replay check, selection (credits locked ascending), the records, the credit state, the frozen certificate and the audit event.
 * A refused request writes nothing.
 */
export async function retireCredits(db:Database,actor:Actor,input:RetireInput){
  requireBuyer(actor);validate(input);
  const requestHash=sha(['retire.v1',input.orderId??null,input.count??null,input.creditIds?[...input.creditIds].sort():null,input.reportingPeriod,input.purpose??null]);
  return withNewWorkLock(db,actor.scenarioId,async tx=>{
    const prior=(await tx.query('SELECT * FROM demo_retirements WHERE scenario_id=$1 AND buyer_id=$2 AND request_id=$3',[actor.scenarioId,actor.id,input.requestId])).rows[0];
    if(prior){
      if(prior.request_hash!==requestHash)throw new WorkflowError('KEY_REUSE');
      return retirementView(tx,prior,true);
    }
    const creditIds=await select(tx,actor,input);
    const retirement=(await tx.query(`INSERT INTO demo_retirements(id,scenario_id,buyer_id,request_id,request_hash,reporting_period,purpose,credit_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),actor.scenarioId,actor.id,input.requestId,requestHash,input.reportingPeriod,input.purpose??null,creditIds.length])).rows[0];
    await tx.query(`INSERT INTO demo_retirement_items(retirement_id,scenario_id,credit_id) SELECT $1,$2,x FROM unnest($3::text[]) AS x`,[retirement.id,actor.scenarioId,creditIds]);
    await tx.query(`UPDATE demo_credits SET state='RETIRED' WHERE id=ANY($1::text[])`,[creditIds]);
    const issuedAt=new Date((await tx.query('SELECT clock_timestamp() AS t')).rows[0].t);
    let certificate:any;
    for(let attempt=0;attempt<3&&!certificate;attempt++){
      const number=newCertificateNumber('GC-RETIRE'),content=await buildContent(tx,retirement,creditIds,number,issuedAt);
      // Only a random-number collision conflicts here (the retirement is new); retry with another number.
      certificate=(await tx.query(`INSERT INTO demo_retirement_certificates(retirement_id,scenario_id,number,content,content_sha256,issued_at) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (number) DO NOTHING RETURNING *`,[retirement.id,actor.scenarioId,number,JSON.stringify(content),certificateHash(content),issuedAt])).rows[0];
    }
    if(!certificate)throw new WorkflowError('CERTIFICATE_NUMBER_EXHAUSTED',503);
    const anchor=(await tx.query('SELECT group_id FROM demo_order_items WHERE credit_id=$1 AND active',[creditIds[0]])).rows[0]?.group_id;
    if(anchor)await appendAudit(tx,actor,anchor,'market.credits.retired',{retirementId:retirement.id,credits:creditIds.length,reportingPeriod:input.reportingPeriod,
      number:certificate.number,contentSha256:certificate.content_sha256});
    return retirementView(tx,retirement,false);
  });
}
/** GET /retirements: the buyer's retirements, newest first, and its purchased, retired and still-held credit totals. */
export async function listRetirements(db:Database,actor:Actor){
  requireBuyer(actor);
  const rows=(await db.query(`SELECT r.id,r.reporting_period,r.purpose,r.credit_count,r.created_at,c.number FROM demo_retirements r
    JOIN demo_retirement_certificates c ON c.retirement_id=r.id WHERE r.scenario_id=$1 AND r.buyer_id=$2 ORDER BY r.created_at DESC,r.id LIMIT 50`,[actor.scenarioId,actor.id])).rows;
  const totals=(await db.query(`SELECT count(*)::int AS purchased,count(*) FILTER (WHERE c.state='RETIRED')::int AS retired,count(*) FILTER (WHERE c.state='SOLD')::int AS held
    FROM demo_ledger_entries e JOIN demo_orders o ON o.id=e.order_id JOIN demo_credits c ON c.id=e.credit_id
    WHERE o.scenario_id=$1 AND o.buyer_id=$2 AND o.state='FULFILLED'`,[actor.scenarioId,actor.id])).rows[0];
  return {namespace:'DEMO_ONLY' as const,label:DEMO_LABEL,
    retirements:rows.map(r=>({id:r.id as string,creditCount:r.credit_count as number,reportingPeriod:r.reporting_period as string,purpose:(r.purpose??null) as string|null,
      createdAt:new Date(r.created_at).toISOString(),certificateNumber:r.number as string})),
    totals:{purchased:totals.purchased as number,retired:totals.retired as number,held:totals.held as number}};
}
/** GET /retirements/:id/certificate. Another buyer's retirement is indistinguishable from a missing one. */
export async function getRetirementCertificate(db:Database,actor:Actor,retirementId:string):Promise<{certificate:CertificateView}>{
  requireBuyer(actor);
  if(typeof retirementId!=='string'||!UUID.test(retirementId))throw new WorkflowError('NOT_FOUND',404);
  const row=(await db.query(`SELECT c.* FROM demo_retirement_certificates c JOIN demo_retirements r ON r.id=c.retirement_id WHERE r.id=$1 AND r.scenario_id=$2 AND r.buyer_id=$3`,
    [retirementId,actor.scenarioId,actor.id])).rows[0];
  if(!row)throw new WorkflowError('NOT_FOUND',404);
  return {certificate:certificateView(row)};
}
