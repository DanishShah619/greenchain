/**
 * Which releasable lots one payout takes (docs/23 P8). Lots arrive oldest first. A lot larger than the limit can never be
 * paid whole (lot splitting is deferred), so it is skipped and reported; otherwise selection stops at the first lot that no
 * longer fits, so a younger lot never overtakes an older one.
 */
export function selectLots<T extends {id:string;netPaise:bigint}>(lots:readonly T[],limitPaise:bigint):{taken:string[];totalPaise:bigint;oversized:string[]}{
  if(limitPaise<=0n)throw new Error('the payout limit must be positive');
  const taken:string[]=[],oversized:string[]=[];let total=0n,full=false;
  for(const lot of lots){
    if(lot.netPaise>limitPaise){oversized.push(lot.id);continue;}
    if(full)continue;
    if(total+lot.netPaise>limitPaise){full=true;continue;}
    taken.push(lot.id);total+=lot.netPaise;
  }
  return {taken,totalPaise:total,oversized};
}
