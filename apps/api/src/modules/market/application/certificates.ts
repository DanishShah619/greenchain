import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
import {appendAudit} from '../../audit/application/audit.js';
import type {Actor} from '../../capture/application/capture.js';
import {certificateHash,CERTIFICATE_NUMBER,newCertificateNumber} from '../domain/certificate.js';
import {groupLabel,orderAnchor,ownedOrder,requireBuyer} from './orders.js';
/**
 * Purchase certificates (docs/24 C1-C6). One per FULFILLED order, built only from stored rows: the order, its ledger rows, the
 * credits and their issuance batches, and each batch's chain proof when it is CONFIRMED. Issued on first request and frozen:
 * the content and its SHA-256 (over canonical JSON) never change, so the certificate always reconciles to the sale it records.
 * No farmer PII or case ids: farmer groups appear by their pseudonymous label.
 */
export const DEMO_CERTIFICATE_LABEL='Demonstration certificate: synthetic demo credits and simulated payment. Not a recognised carbon credit.';
export type CertificateView={number:string;content:Record<string,unknown>;contentSha256:string;issuedAt:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const view=(r:any):CertificateView=>({number:r.number,content:r.content,contentSha256:r.content_sha256,issuedAt:new Date(r.issued_at).toISOString()});
/** The certificate content of a fulfilled order, from stored rows only. `issuedAt` is part of the frozen content. */
async function buildContent(tx:Database,order:any,number:string,issuedAt:Date){
  const rows=(await tx.query(`SELECT e.credit_id,e.payee_group_id::text AS payee,e.gross_paise::text AS gross,e.created_at,b.vintage,b.id::text AS batch,
      p.status AS proof_status,p.network,p.transaction_hash
    FROM demo_ledger_entries e JOIN demo_credits c ON c.id=e.credit_id JOIN demo_issuance_batches b ON b.id=c.batch_id
    LEFT JOIN demo_chain_proofs p ON p.batch_id=b.id WHERE e.order_id=$1 ORDER BY e.credit_id`,[order.id])).rows;
  if(rows.length!==order.allocated_quantity)throw new WorkflowError('CERTIFICATE_MISMATCH',409);
  const groups=new Map<string,number>(),proofs=new Map<string,Record<string,unknown>>();
  for(const r of rows){
    const label=groupLabel(r.payee);groups.set(label,(groups.get(label)??0)+1);
    if(!proofs.has(r.batch))proofs.set(r.batch,r.proof_status==='CONFIRMED'&&r.network!==null&&r.transaction_hash
      ?{group:label,status:'CONFIRMED',network:Number(r.network),transactionHash:r.transaction_hash}:{group:label,status:'PENDING'});
  }
  const fulfilledAt=new Date(Math.max(...rows.map(r=>new Date(r.created_at).getTime())));
  return {
    schema:'greenchain-demo-certificate-v1',namespace:'DEMO_ONLY',label:DEMO_CERTIFICATE_LABEL,number,issuedAt:issuedAt.toISOString(),
    buyer:{account:order.buyer_id as string},
    order:{fulfilledAt:fulfilledAt.toISOString(),quantity:rows.length,unitPricePaise:String(order.unit_price_paise),grossPaise:String(order.principal_paise),
      taxPaise:String(order.tax_paise),taxRule:order.tax_rule as string,payablePaise:String(order.payable_paise),currency:'INR'},
    credits:rows.map(r=>({id:r.credit_id as string,tonnes:'1',vintage:Number(r.vintage),group:groupLabel(r.payee)})),
    groups:[...groups].map(([group,credits])=>({group,credits})).sort((a,b)=>a.group<b.group?-1:a.group>b.group?1:0),
    proofs:[...proofs.values()].sort((a,b)=>String(a.group)<String(b.group)?-1:1),
    verification:{path:`/api/v1/certificates/${number}`},
  };
}
async function orderFor(tx:Database,actor:Actor,orderId:string,asPresenter:boolean){
  if(!asPresenter){requireBuyer(actor);return ownedOrder(tx,actor,orderId,false);}
  if(typeof orderId!=='string'||!UUID.test(orderId))throw new WorkflowError('NOT_FOUND',404);
  const row=(await tx.query('SELECT * FROM demo_orders WHERE id=$1 AND scenario_id=$2',[orderId,actor.scenarioId])).rows[0];
  if(!row)throw new WorkflowError('NOT_FOUND',404);
  return row;
}
/** Issues (or returns) the certificate of an order. Idempotent: concurrent first requests produce one certificate. */
export async function issueCertificate(db:Database,actor:Actor,orderId:string,o:{asPresenter?:boolean}={}):Promise<{certificate:CertificateView;replayed:boolean}>{
  return db.transaction(async tx=>{
    const order=await orderFor(tx,actor,orderId,o.asPresenter??false);
    const existing=(await tx.query('SELECT * FROM demo_certificates WHERE order_id=$1',[order.id])).rows[0];
    if(existing)return {certificate:view(existing),replayed:true};
    if(order.state!=='FULFILLED')throw new WorkflowError('ORDER_NOT_FULFILLED',409);
    const issuedAt=new Date((await tx.query('SELECT clock_timestamp() AS t')).rows[0].t);
    for(let attempt=0;attempt<3;attempt++){
      const number=newCertificateNumber(),content=await buildContent(tx,order,number,issuedAt);
      const inserted=(await tx.query(`INSERT INTO demo_certificates(order_id,scenario_id,number,content,content_sha256,issued_at) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT DO NOTHING RETURNING *`,[order.id,order.scenario_id,number,JSON.stringify(content),certificateHash(content),issuedAt])).rows[0];
      if(inserted){
        const anchor=await orderAnchor(tx,order.id);
        if(anchor)await appendAudit(tx,actor,anchor,'market.certificate.issued',{orderId:order.id,number,contentSha256:inserted.content_sha256});
        return {certificate:view(inserted),replayed:false};
      }
      // Another request issued it first (order conflict), or the random number collided (retry with a new one).
      const raced=(await tx.query('SELECT * FROM demo_certificates WHERE order_id=$1',[order.id])).rows[0];
      if(raced)return {certificate:view(raced),replayed:true};
    }
    throw new WorkflowError('CERTIFICATE_NUMBER_EXHAUSTED',503);
  });
}
export async function getCertificate(db:Database,actor:Actor,orderId:string,o:{asPresenter?:boolean}={}):Promise<{certificate:CertificateView}>{
  const order=await orderFor(db,actor,orderId,o.asPresenter??false);
  const row=(await db.query('SELECT * FROM demo_certificates WHERE order_id=$1',[order.id])).rows[0];
  if(!row)throw new WorkflowError('CERTIFICATE_NOT_ISSUED',404);
  return {certificate:view(row)};
}
/**
 * Public verification by number (docs/24 C5): the content with the buyer account withheld, whether the stored content still
 * hashes to the stored hash (intact), and, when a hash is given, whether it matches.
 */
export async function verifyCertificate(db:Database,number:string,hash?:string){
  if(!CERTIFICATE_NUMBER.test(number))throw new WorkflowError('NOT_FOUND',404);
  const row=(await db.query('SELECT number,content,content_sha256,issued_at FROM demo_certificates WHERE number=$1',[number])).rows[0];
  if(!row)throw new WorkflowError('NOT_FOUND',404);
  const intact=certificateHash(row.content)===row.content_sha256;
  return {namespace:'DEMO_ONLY' as const,number:row.number as string,content:{...row.content,buyer:{account:'Demo buyer'}},contentSha256:row.content_sha256 as string,
    issuedAt:new Date(row.issued_at).toISOString(),intact,...(hash===undefined?{}:{hashMatches:intact&&hash===row.content_sha256})};
}
