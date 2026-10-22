/**
 * FCAE v0 (docs/22 §6.3, docs/06 §6): the fair-allocation rule with every tier weight equal to 1.
 * Pure and deterministic: the same stored inputs give the same output regardless of input order, and nothing here reads the
 * clock or the database. The caller supplies the numbers it read under the scenario lock.
 */
export type GroupInput={groupId:string;available:number;reserved:number;waitingDays:number;creditIds:string[]};
export type Allocation={groupId:string;count:number;creditIds:string[]};
export type ShortfallReason='SUPPLY'|'CAP'|'QUOTA';
export type FcaeResult=
  |{ok:true;cap:number;allocations:Allocation[]}
  |{ok:false;cap:number;reason:ShortfallReason;offeredCount:number;allocations:Allocation[]};
export type FcaeOptions={
  /** Build the cap from this order size. For a partial fill this is the ORIGINAL quantity, so the cap does not shrink. */
  capBasisQ:number;
  /** REVALIDATING orders skip the per-group reservation quota. The cap still applies. */
  skipQuota:boolean;
  /** Allocate exactly this many credits instead of the full quantity (accepting a partial fill). */
  take?:number;
};
/** v0 gives every FRPS tier the same weight (docs/22 B4). Recorded in the allocation log so a later, weighted version is comparable. */
export const TIER_WEIGHT_V0=1;
/** Per-group cap per order: 15% of the order, at least 1. */
export const capFor=(q:number)=>Math.max(1,Math.floor(0.15*q));
/** Reservation quota of a group: at most half of its (available + reserved) stock may be reserved at once, at least 1. */
export const quotaFor=(available:number,reserved:number)=>Math.max(1,Math.floor(0.5*(available+reserved)));
const DAY=86_400_000;
/** Whole days a group has waited, from the later of its last sale and the moment it first had stock. Never negative. */
export function waitingDays(asOf:Date,lastAllocatedAt:Date|null,oldestAvailableAt:Date):number{
  const since=Math.max(lastAllocatedAt?.getTime()??-Infinity,oldestAvailableAt.getTime());
  return Math.max(0,Math.floor((asOf.getTime()-since)/DAY));
}
const byId=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function allocateFcaeV0(input:GroupInput[],q:number,options:FcaeOptions):FcaeResult{
  if(!Number.isInteger(q)||q<1)throw new Error('quantity must be a positive integer');
  const target=options.take??q;
  if(!Number.isInteger(target)||target<1||target>q)throw new Error('take must be between 1 and the order quantity');
  const cap=capFor(options.capBasisQ);
  // Longest waiting first; ties break on group id so the order never depends on how the rows arrived.
  const groups=[...input].sort((a,b)=>b.waitingDays-a.waitingDays||byId(a.groupId,b.groupId)).map(g=>{
    const ids=[...g.creditIds].sort(byId),available=Math.min(g.available,ids.length);
    const room=options.skipQuota?Infinity:Math.max(0,quotaFor(g.available,g.reserved)-g.reserved);
    return {groupId:g.groupId,ids,available,usable:Math.min(available,cap,room)};
  });
  const sum=(f:(g:typeof groups[number])=>number)=>groups.reduce((n,g)=>n+f(g),0);
  const usable=sum(g=>g.usable);
  const goal=Math.min(target,usable);
  // One credit per group per round, in waiting order, so a large order spreads across groups instead of draining one.
  const taken=new Map<string,number>();let total=0;
  for(let progressed=true;total<goal&&progressed;){
    progressed=false;
    for(const g of groups){
      if(total>=goal)break;
      const n=taken.get(g.groupId)??0;
      if(n<g.usable){taken.set(g.groupId,n+1);total++;progressed=true;}
    }
  }
  const allocations=groups.filter(g=>(taken.get(g.groupId)??0)>0).map(g=>{const count=taken.get(g.groupId)!;return {groupId:g.groupId,count,creditIds:g.ids.slice(0,count)};});
  if(usable>=target)return {ok:true,cap,allocations};
  // The binding reason is the first limit that, relaxed on its own, would not have been enough: stock, then cap, then quota.
  const reason:ShortfallReason=sum(g=>g.available)<target?'SUPPLY':sum(g=>Math.min(g.available,cap))<target?'CAP':'QUOTA';
  return {ok:false,cap,reason,offeredCount:total,allocations};
}
