import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
import {appendAudit} from '../../audit/application/audit.js';
import type {Actor} from '../../capture/application/capture.js';
import {allocateFcaeV0,quotaFor,TIER_WEIGHT_V0,waitingDays,type FcaeResult,type GroupInput} from '../domain/fcae.js';
import {withNewWorkLock,withScenarioLock} from './lock.js';
/** Buyer orders: create (allocate and reserve), accept a partial offer, cancel, and the reservation reaper (docs/22 §6.2-6.3). */
export type MarketConfig={commissionBps:number;reservationSeconds:number;shortfallHoldSeconds:number};
export const DEFAULT_MARKET:MarketConfig={commissionBps:500,reservationSeconds:300,shortfallHoldSeconds:900};
/** Orders that hold credits and count toward a buyer's open-order limit. */
export const HOLDING_STATES=['RESERVED','AWAITING_PAYMENT','REVALIDATING'];
export const BUYER_MAX_OPEN_ORDERS=3,BUYER_MAX_SUPPLY_SHARE=0.10;
/** Carried by every buyer response (docs/22 §9), next to namespace DEMO_ONLY. */
export const DEMO_LABEL='Demonstration — synthetic credits and simulated payments';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money=(value:unknown)=>BigInt(String(value));
const iso=(value:unknown)=>value?new Date(value as string).toISOString():null;
/** The exact terms a buyer accepts before paying: price, quantity, amount, commission and tax rule. */
export const snapshotHash=(order:Record<string,any>)=>sha(['order.snapshot.v1',order.id,String(order.unit_price_paise),order.allocated_quantity,String(order.payable_paise),order.commission_bps,order.tax_rule]);
/** A pseudonymous, stable label for a farmer group. Buyers never see names, villages or areas. */
export const groupLabel=(groupId:string)=>`Group ${createHash('sha256').update(`group:${groupId}`).digest('hex').slice(0,6).toUpperCase()}`;
export const systemActor=(scenarioId:string):Actor=>({id:'system:market',scenarioId,role:'system'});
export function requireBuyer(actor:Actor){if(actor.role!=='buyer')throw new WorkflowError('FORBIDDEN',403);}
const isUniqueViolation=(error:unknown)=>(error as {code?:unknown})?.code==='23505';
export type CreateOrderInput={requestId:string;quantity:number;quotedTotalPaise?:string};
function validate(input:CreateOrderInput){
  if(typeof input.requestId!=='string'||!UUID.test(input.requestId))throw new WorkflowError('INVALID_REQUEST_ID',422);
  if(!Number.isInteger(input.quantity)||input.quantity<1||input.quantity>100)throw new WorkflowError('INVALID_QUANTITY',422);
  if(input.quotedTotalPaise!==undefined&&(typeof input.quotedTotalPaise!=='string'||!/^[0-9]{1,18}$/.test(input.quotedTotalPaise)))throw new WorkflowError('INVALID_QUOTE',422);
}
/** Audit events attach to a case (docs/22 B12): the case of the order's lowest credit id. With nothing allocated there is no case. */
async function audit(tx:Database,actor:Actor,anchorCapture:string|undefined,event:string,facts:Record<string,unknown>){
  if(anchorCapture)await appendAudit(tx,actor,anchorCapture,event,facts);
}
/** The case behind the order's lowest credit id, over every generation of holds. */
export async function orderAnchor(tx:Database,orderId:string):Promise<string|undefined>{
  return (await tx.query('SELECT group_id FROM demo_order_items WHERE order_id=$1 ORDER BY credit_id LIMIT 1',[orderId])).rows[0]?.group_id;
}
async function priceAt(tx:Database,scenarioId:string,asOf:Date){
  const row=(await tx.query('SELECT unit_price_paise,effective_from FROM demo_price_list WHERE scenario_id=$1 AND effective_from<=$2 ORDER BY effective_from DESC LIMIT 1',[scenarioId,asOf])).rows[0];
  if(!row)throw new WorkflowError('PRICE_NOT_CONFIGURED',422);
  return {unitPrice:money(row.unit_price_paise),effectiveFrom:row.effective_from as Date};
}
/** Per-group supply, recounted from demo_credits under the lock (docs/22 B6). */
async function readGroups(tx:Database,scenarioId:string,asOf:Date):Promise<GroupInput[]>{
  const rows=(await tx.query(`SELECT b.capture_id AS group_id,c.id,c.state,c.available_since,g.last_allocated_at
    FROM demo_credits c JOIN demo_issuance_batches b ON b.id=c.batch_id
    LEFT JOIN demo_group_state g ON g.scenario_id=b.scenario_id AND g.group_id=b.capture_id
    WHERE b.scenario_id=$1 AND c.state IN ('AVAILABLE','RESERVED')`,[scenarioId])).rows;
  const groups=new Map<string,{available:string[];reserved:number;oldest:Date|null;last:Date|null}>();
  for(const row of rows){
    const g=groups.get(row.group_id)??{available:[],reserved:0,oldest:null,last:row.last_allocated_at?new Date(row.last_allocated_at):null};
    if(row.state==='AVAILABLE'){g.available.push(row.id);const since=new Date(row.available_since);if(!g.oldest||since<g.oldest)g.oldest=since;}
    else g.reserved++;
    groups.set(row.group_id,g);
  }
  return [...groups].map(([groupId,g])=>({groupId,available:g.available.length,reserved:g.reserved,creditIds:g.available,waitingDays:g.oldest?waitingDays(asOf,g.last,g.oldest):0}));
}
/** Per-buyer limits (docs/22 B11): at most 3 open orders, and at most 10% of eligible supply (at least 1) reserved at once. */
async function checkLimits(tx:Database,actor:Actor,wanted:number){
  const row=(await tx.query(`SELECT
      (SELECT count(*)::int FROM demo_orders WHERE scenario_id=$1 AND buyer_id=$2 AND state=ANY($3::text[])) AS open,
      (SELECT count(*)::int FROM demo_credits c JOIN demo_orders o ON o.id=c.reserved_order_id WHERE o.scenario_id=$1 AND o.buyer_id=$2 AND c.state='RESERVED') AS reserved,
      (SELECT count(*)::int FROM demo_credits c JOIN demo_issuance_batches b ON b.id=c.batch_id WHERE b.scenario_id=$1 AND c.state IN ('AVAILABLE','RESERVED')) AS eligible`,
    [actor.scenarioId,actor.id,HOLDING_STATES])).rows[0];
  if(row.open>=BUYER_MAX_OPEN_ORDERS)throw new WorkflowError('BUYER_LIMIT',422);
  if(row.reserved+wanted>Math.max(1,Math.floor(BUYER_MAX_SUPPLY_SHARE*row.eligible)))throw new WorkflowError('BUYER_LIMIT',422);
}
/** One immutable row per allocation revision: per-group inputs, weight and quota, the cap, the result and any shortfall (docs/22 §5). */
async function logAllocation(tx:Database,orderId:string,scenarioId:string,revision:number,asOf:Date,capBasisQ:number,inputs:GroupInput[],result:FcaeResult,take?:number){
  const detail={take:take??null,cap:result.cap,ok:result.ok,reason:result.ok?null:result.reason,offeredCount:result.ok?null:result.offeredCount,
    groups:inputs.map(g=>({groupId:g.groupId,available:g.available,reserved:g.reserved,waitingDays:g.waitingDays,weight:TIER_WEIGHT_V0,quota:quotaFor(g.available,g.reserved)})),
    allocations:result.allocations};
  await tx.query('INSERT INTO demo_allocation_log(order_id,scenario_id,revision,as_of,cap_basis_q,detail) VALUES ($1,$2,$3,$4,$5,$6)',[orderId,scenarioId,revision,asOf,capBasisQ,JSON.stringify(detail)]);
}
/** Holds and reserves the allocated credits for an order. Credits are locked in ascending id order. Returns the audit anchor. */
async function reserve(tx:Database,scenarioId:string,orderId:string,result:FcaeResult,generation:number){
  const picks=result.allocations.flatMap(a=>a.creditIds.map(credit=>({credit,group:a.groupId}))).sort((a,b)=>a.credit<b.credit?-1:1);
  const ids=picks.map(p=>p.credit);
  const locked=(await tx.query('SELECT id,state FROM demo_credits WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[ids])).rows;
  // Under the scenario lock nothing else can change these rows; a mismatch means a writer bypassed the lock.
  if(locked.length!==ids.length||locked.some(r=>r.state!=='AVAILABLE'))throw new WorkflowError('ALLOCATION_CONFLICT',503);
  await tx.query(`INSERT INTO demo_order_items(order_id,scenario_id,credit_id,group_id,generation) SELECT $1,$2,x.credit,x.grp,$5 FROM unnest($3::text[],$4::uuid[]) AS x(credit,grp)`,[orderId,scenarioId,ids,picks.map(p=>p.group),generation]);
  await tx.query(`UPDATE demo_credits SET state='RESERVED',reserved_order_id=$1 WHERE id=ANY($2::text[])`,[orderId,ids]);
  return picks[0]?.group as string|undefined;
}
/** Deactivates every hold of the given orders and returns their reserved credits to AVAILABLE. available_since is untouched. */
async function release(tx:Database,orderIds:string[]){
  if(!orderIds.length)return 0;
  const credits=(await tx.query(`SELECT id FROM demo_credits WHERE reserved_order_id=ANY($1::uuid[]) AND state='RESERVED' ORDER BY id FOR UPDATE`,[orderIds])).rows;
  await tx.query('UPDATE demo_order_items SET active=false WHERE order_id=ANY($1::uuid[]) AND active',[orderIds]);
  await tx.query(`UPDATE demo_credits SET state='AVAILABLE',reserved_order_id=NULL WHERE reserved_order_id=ANY($1::uuid[]) AND state='RESERVED'`,[orderIds]);
  return credits.length;
}
/**
 * Expires lapsed reservations and cancels stale shortfall offers. Call only inside withScenarioLock. It makes no provider call:
 * a payment that succeeds after expiry is handled by the late-success path (docs/22 §6.2).
 */
export async function reapExpired(tx:Database,scenarioId:string,asOf:Date,config:MarketConfig=DEFAULT_MARKET){
  const lapsed=(await tx.query(`SELECT id FROM demo_orders WHERE scenario_id=$1 AND state IN ('RESERVED','AWAITING_PAYMENT') AND reserved_until<=$2 ORDER BY id FOR UPDATE`,[scenarioId,asOf])).rows.map(r=>r.id as string);
  const anchors=new Map<string,string|undefined>();
  for(const id of lapsed)anchors.set(id,await orderAnchor(tx,id));
  const released=await release(tx,lapsed);
  if(lapsed.length)await tx.query(`UPDATE demo_orders SET state='EXPIRED',version=version+1 WHERE id=ANY($1::uuid[])`,[lapsed]);
  for(const id of lapsed)await audit(tx,systemActor(scenarioId),anchors.get(id),'market.order.expired',{orderId:id});
  const stale=(await tx.query(`SELECT id FROM demo_orders WHERE scenario_id=$1 AND state='CREATED' AND created_at<=$2::timestamptz-make_interval(secs=>$3) ORDER BY id FOR UPDATE`,[scenarioId,asOf,config.shortfallHoldSeconds])).rows.map(r=>r.id as string);
  if(stale.length)await tx.query(`UPDATE demo_orders SET state='CANCELLED',version=version+1 WHERE id=ANY($1::uuid[])`,[stale]);
  return {expired:lapsed.length,released,shortfallsCancelled:stale.length};
}
export type OrderView=Awaited<ReturnType<typeof orderView>>;
/** The buyer's view, rebuilt from stored rows (never recomputed). Contains no farmer data. */
export async function orderView(tx:Database,order:Record<string,any>,extra:{replayed:boolean;quotedTotalPaise?:string}){
  const items=(await tx.query(`SELECT credit_id,group_id,active FROM demo_order_items WHERE order_id=$1 AND generation=(SELECT max(generation) FROM demo_order_items WHERE order_id=$1) ORDER BY credit_id`,[order.id])).rows;
  const log=(await tx.query('SELECT revision,as_of,cap_basis_q,detail FROM demo_allocation_log WHERE order_id=$1 ORDER BY revision DESC LIMIT 1',[order.id])).rows[0];
  const detail=log?(typeof log.detail==='string'?JSON.parse(log.detail):log.detail):null;
  const unitPrice=money(order.unit_price_paise);
  const attempts=(await tx.query('SELECT id,state,amount_paise,mismatch,created_at FROM demo_payment_attempts WHERE order_id=$1 ORDER BY created_at,id',[order.id])).rows;
  const refunds=(await tx.query('SELECT kind,state,amount_paise FROM demo_payment_refunds WHERE order_id=$1 ORDER BY created_at,id',[order.id])).rows;
  const ledger=(await tx.query('SELECT e.credit_id,e.gross_paise,c.state FROM demo_ledger_entries e JOIN demo_credits c ON c.id=e.credit_id WHERE e.order_id=$1 ORDER BY e.credit_id',[order.id])).rows;
  return {
    namespace:'DEMO_ONLY' as const,label:DEMO_LABEL,replayed:extra.replayed,
    priceChangedFromQuote:extra.quotedTotalPaise!==undefined&&extra.quotedTotalPaise!==String(unitPrice*BigInt(order.quantity)),
    order:{id:order.id as string,state:order.state as string,quantity:order.quantity as number,allocatedQuantity:order.allocated_quantity as number,
      currency:'INR' as const,unitPricePaise:String(unitPrice),principalPaise:String(order.principal_paise),taxPaise:String(order.tax_paise),taxRule:order.tax_rule as string,
      payablePaise:String(order.payable_paise),commissionBps:order.commission_bps as number,priceEffectiveFrom:iso(order.price_effective_from),
      reservedUntil:iso(order.reserved_until),allocatedAt:iso(order.allocated_at),shortfallReason:(order.shortfall_reason??null) as string|null,
      version:order.version as number,createdAt:iso(order.created_at)},
    snapshotHash:snapshotHash(order),
    items:items.map(i=>({creditId:i.credit_id as string,group:groupLabel(i.group_id),active:i.active as boolean})),
    payments:attempts.map(a=>({id:a.id as string,state:a.state as string,amountPaise:String(a.amount_paise),mismatch:a.mismatch as boolean,createdAt:iso(a.created_at)})),
    refunds:refunds.map(r=>({kind:r.kind as string,state:r.state as string,amountPaise:String(r.amount_paise)})),
    purchased:ledger.map(l=>({creditId:l.credit_id as string,pricePaise:String(l.gross_paise),retired:l.state==='RETIRED'})),
    allocation:detail?{revision:log.revision as number,asOf:iso(log.as_of),capBasisQuantity:log.cap_basis_q as number,cap:detail.cap as number,ok:detail.ok as boolean,
      reason:(detail.reason??null) as string|null,offeredCount:(detail.offeredCount??null) as number|null,
      groups:(detail.allocations as {groupId:string;count:number}[]).map(a=>({group:groupLabel(a.groupId),count:a.count}))}:null
  };
}
export async function ownedOrder(tx:Database,actor:Actor,orderId:string,lock:boolean){
  if(typeof orderId!=='string'||!UUID.test(orderId))throw new WorkflowError('NOT_FOUND',404);
  const row=(await tx.query(`SELECT * FROM demo_orders WHERE id=$1 AND scenario_id=$2 AND buyer_id=$3${lock?' FOR UPDATE':''}`,[orderId,actor.scenarioId,actor.id])).rows[0];
  // Another buyer's or another scenario's order is indistinguishable from a missing one.
  if(!row)throw new WorkflowError('NOT_FOUND',404);
  return row;
}
const byRequest=async(tx:Database,actor:Actor,requestId:string)=>(await tx.query('SELECT * FROM demo_orders WHERE scenario_id=$1 AND buyer_id=$2 AND request_id=$3',[actor.scenarioId,actor.id,requestId])).rows[0];
/**
 * The unique indexes backstop the scenario lock (docs/22 §6.3), so a 23505 is never answered with a 500. A request-key conflict
 * means another request with this key won: `replayed` answers with its order. An item-index conflict means a credit was held by a
 * writer that bypassed the lock; everything rolled back, so the work runs once more in a fresh transaction that re-reads supply.
 * If that conflicts too, the caller gets a retryable 503.
 */
async function backstopUniqueViolation<T>(work:()=>Promise<T>,replayed:()=>Promise<T|undefined>=async()=>undefined):Promise<T>{
  for(let tries=1;;tries++){
    try{return await work();}
    catch(error){
      if(!isUniqueViolation(error))throw error;
      const prior=await replayed();if(prior)return prior;
      if(tries>=2)throw new WorkflowError('ALLOCATION_CONFLICT',503);
    }
  }
}
/**
 * POST /orders. One transaction under the scenario lock: replay check, reap, buyer limits, price, FCAE v0, then either a
 * RESERVED order with held credits or a CREATED order carrying a shortfall offer and nothing reserved.
 */
export async function createOrder(db:Database,actor:Actor,input:CreateOrderInput,config:MarketConfig=DEFAULT_MARKET):Promise<OrderView>{
  requireBuyer(actor);validate(input);
  const requestHash=sha(['order.create.v1',input.quantity,input.quotedTotalPaise??null]);
  const replay=(prior:Record<string,any>,tx:Database)=>{
    if(prior.request_hash!==requestHash)throw new WorkflowError('KEY_REUSE');
    return orderView(tx,prior,{replayed:true,quotedTotalPaise:input.quotedTotalPaise});
  };
  return backstopUniqueViolation(()=>withNewWorkLock(db,actor.scenarioId,async(tx,asOf)=>{
      const prior=await byRequest(tx,actor,input.requestId);
      if(prior)return replay(prior,tx);
      await reapExpired(tx,actor.scenarioId,asOf,config);
      await checkLimits(tx,actor,input.quantity);
      const price=await priceAt(tx,actor.scenarioId,asOf);
      const inputs=await readGroups(tx,actor.scenarioId,asOf);
      const result=allocateFcaeV0(inputs,input.quantity,{capBasisQ:input.quantity,skipQuota:false});
      const id=randomUUID(),allocated=result.ok?input.quantity:0,principal=price.unitPrice*BigInt(allocated);
      const order=(await tx.query(`INSERT INTO demo_orders(id,scenario_id,buyer_id,request_id,request_hash,quantity,allocated_quantity,state,unit_price_paise,price_effective_from,commission_bps,principal_paise,payable_paise,shortfall_reason,reserved_until,allocated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15) RETURNING *`,
        [id,actor.scenarioId,actor.id,input.requestId,requestHash,input.quantity,allocated,result.ok?'RESERVED':'CREATED',String(price.unitPrice),price.effectiveFrom,config.commissionBps,String(principal),
         result.ok?null:result.reason,result.ok?new Date(asOf.getTime()+config.reservationSeconds*1000):null,result.ok?asOf:null])).rows[0];
      await logAllocation(tx,id,actor.scenarioId,1,asOf,input.quantity,inputs,result);
      if(result.ok){
        const anchor=await reserve(tx,actor.scenarioId,id,result,1);
        await audit(tx,actor,anchor,'market.order.reserved',{orderId:id,quantity:allocated,unitPricePaise:String(price.unitPrice)});
      }
      return orderView(tx,order,{replayed:false,quotedTotalPaise:input.quotedTotalPaise});
    }),
    ()=>db.transaction(async tx=>{const prior=await byRequest(tx,actor,input.requestId);return prior?replay(prior,tx):undefined;}));
}
/**
 * Accept the partial offer of a shortfall order. Allocation is re-run under the lock for exactly the offered count, with the cap
 * of the ORIGINAL quantity. If supply changed so that count no longer fits, a new offer is returned and nothing is reserved.
 */
export async function acceptPartial(db:Database,actor:Actor,orderId:string,config:MarketConfig=DEFAULT_MARKET):Promise<OrderView>{
  requireBuyer(actor);
  return backstopUniqueViolation(()=>withNewWorkLock(db,actor.scenarioId,async(tx,asOf)=>{
    const order=await ownedOrder(tx,actor,orderId,true);
    if(order.state!=='CREATED'){
      // A repeated accept after success is answered with the current order.
      if(order.shortfall_reason&&HOLDING_STATES.includes(order.state))return orderView(tx,order,{replayed:true});
      throw new WorkflowError('ORDER_NOT_PARTIAL');
    }
    const last=(await tx.query('SELECT revision,detail FROM demo_allocation_log WHERE order_id=$1 ORDER BY revision DESC LIMIT 1',[order.id])).rows[0];
    const detail=last?(typeof last.detail==='string'?JSON.parse(last.detail):last.detail):null;
    const offered=Number(detail?.offeredCount??0);
    if(offered<1)throw new WorkflowError('NOTHING_TO_ACCEPT');
    await reapExpired(tx,actor.scenarioId,asOf,config);
    // The reaper may just have cancelled this offer as stale.
    if((await tx.query('SELECT state FROM demo_orders WHERE id=$1',[order.id])).rows[0].state!=='CREATED')throw new WorkflowError('OFFER_EXPIRED');
    await checkLimits(tx,actor,offered);
    const inputs=await readGroups(tx,actor.scenarioId,asOf);
    const result=allocateFcaeV0(inputs,order.quantity,{take:offered,capBasisQ:order.quantity,skipQuota:false});
    await logAllocation(tx,order.id,actor.scenarioId,last.revision+1,asOf,order.quantity,inputs,result,offered);
    if(!result.ok)return orderView(tx,order,{replayed:false});
    const principal=money(order.unit_price_paise)*BigInt(offered);
    const updated=(await tx.query(`UPDATE demo_orders SET state='RESERVED',allocated_quantity=$2,principal_paise=$3,payable_paise=$3,reserved_until=$4,allocated_at=$5,version=version+1 WHERE id=$1 RETURNING *`,
      [order.id,offered,String(principal),new Date(asOf.getTime()+config.reservationSeconds*1000),asOf])).rows[0];
    const anchor=await reserve(tx,actor.scenarioId,order.id,result,1);
    await audit(tx,actor,anchor,'market.order.reserved',{orderId:order.id,quantity:offered,partial:true,unitPricePaise:String(order.unit_price_paise)});
    return orderView(tx,updated,{replayed:false});
  }));
}
/** Cancel an order that has not been paid. Idempotent: cancelling a cancelled order returns it unchanged. */
export async function cancelOrder(db:Database,actor:Actor,orderId:string):Promise<OrderView>{
  requireBuyer(actor);
  return withScenarioLock(db,actor.scenarioId,async tx=>{
    const order=await ownedOrder(tx,actor,orderId,true);
    if(order.state==='CANCELLED')return orderView(tx,order,{replayed:true});
    if(!['CREATED','RESERVED','AWAITING_PAYMENT'].includes(order.state))throw new WorkflowError('ORDER_NOT_CANCELLABLE');
    const anchor=await orderAnchor(tx,order.id);
    const released=await release(tx,[order.id]);
    const updated=(await tx.query(`UPDATE demo_orders SET state='CANCELLED',version=version+1 WHERE id=$1 RETURNING *`,[order.id])).rows[0];
    await audit(tx,actor,anchor,'market.order.cancelled',{orderId:order.id,released});
    return orderView(tx,updated,{replayed:false});
  });
}
export async function getOrder(db:Database,actor:Actor,orderId:string):Promise<OrderView>{
  requireBuyer(actor);
  return db.transaction(async tx=>orderView(tx,await ownedOrder(tx,actor,orderId,false),{replayed:false}));
}
export async function listOrders(db:Database,actor:Actor){
  requireBuyer(actor);
  const rows=(await db.query(`SELECT id,state,quantity,allocated_quantity,payable_paise,reserved_until,created_at FROM demo_orders WHERE scenario_id=$1 AND buyer_id=$2 ORDER BY created_at DESC,id LIMIT 50`,[actor.scenarioId,actor.id])).rows;
  return {namespace:'DEMO_ONLY' as const,label:DEMO_LABEL,orders:rows.map(r=>({id:r.id as string,state:r.state as string,quantity:r.quantity as number,allocatedQuantity:r.allocated_quantity as number,
    payablePaise:String(r.payable_paise),reservedUntil:iso(r.reserved_until),createdAt:iso(r.created_at)}))};
}
