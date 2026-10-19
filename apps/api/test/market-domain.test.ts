import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allocateFcaeV0,capFor,quotaFor,waitingDays,type GroupInput} from '../src/modules/market/domain/fcae.js';
import {commissionPaise,ledgerLine} from '../src/modules/market/domain/money.js';
// Deterministic pseudo-random numbers so property tests are reproducible.
function rng(seed:number){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};}
const group=(id:string,available:number,reserved=0,waiting=0):GroupInput=>({groupId:id,available,reserved,waitingDays:waiting,creditIds:Array.from({length:available},(_,i)=>`${id}-c${String(i+1).padStart(3,'0')}`)});
const total=(r:{allocations:{count:number}[]})=>r.allocations.reduce((n,a)=>n+a.count,0);
test('cap and quota follow docs/06 §6',()=>{
  assert.deepEqual([1,6,7,13,14,20,100].map(capFor),[1,1,1,1,2,3,15]);
  assert.deepEqual([[1,0],[2,0],[10,0],[10,4],[3,1],[0,1]].map(([a,r])=>quotaFor(a,r)),[1,1,5,7,2,1]);
});
test('waiting days counts whole days from the later of last sale and first availability',()=>{
  const asOf=new Date('2026-10-20T12:00:00Z');
  assert.equal(waitingDays(asOf,null,new Date('2026-10-10T12:00:00Z')),10);
  assert.equal(waitingDays(asOf,new Date('2026-10-18T13:00:00Z'),new Date('2026-10-01T00:00:00Z')),1);
  assert.equal(waitingDays(asOf,new Date('2026-10-30T00:00:00Z'),new Date('2026-10-01T00:00:00Z')),0,'never negative');
});
test('a 20-credit order over 20 groups of 10 takes one credit from the 20 longest-waiting groups, capped at 3 each',()=>{
  const groups=Array.from({length:20},(_,i)=>group(`g${String(i).padStart(2,'0')}`,10,0,i));
  const r=allocateFcaeV0(groups,20,{capBasisQ:20,skipQuota:false});
  assert.equal(r.ok,true);assert.equal(total(r),20);
  assert.ok(r.allocations.every(a=>a.count<=capFor(20)));
  // Round-robin by waiting time: each of 20 groups gets exactly one credit, the lowest credit id first.
  assert.ok(r.allocations.every(a=>a.count===1&&a.creditIds[0]===`${a.groupId}-c001`));
});
test('fewer groups than the order needs: the cap binds and the result is a reported shortfall, never a silent relaxation',()=>{
  const groups=[group('a',50),group('b',50)];
  const r=allocateFcaeV0(groups,20,{capBasisQ:20,skipQuota:false});
  assert.equal(r.ok,false);if(r.ok)return;
  assert.equal(r.reason,'CAP');assert.equal(r.offeredCount,6);assert.ok(r.allocations.every(a=>a.count===3));
});
test('shortfall reasons: SUPPLY when stock is short, CAP when the cap binds, QUOTA when reservations bind',()=>{
  const s=allocateFcaeV0([group('a',2),group('b',1)],10,{capBasisQ:10,skipQuota:false});
  assert.equal(s.ok===false&&s.reason,'SUPPLY');
  const c=allocateFcaeV0([group('a',10),group('b',10)],8,{capBasisQ:8,skipQuota:false});
  assert.equal(c.ok===false&&c.reason,'CAP');
  // quota = max(1, floor(0.5*(a+r))): a=4,r=4 -> 4, room 0; so reserved credits shrink what can be taken.
  const q=allocateFcaeV0([group('a',4,4),group('b',4,4),group('c',4,4)],3,{capBasisQ:3,skipQuota:false});
  assert.equal(q.ok===false&&q.reason,'QUOTA');
  const revalidating=allocateFcaeV0([group('a',4,4),group('b',4,4),group('c',4,4)],3,{capBasisQ:3,skipQuota:true});
  assert.equal(revalidating.ok,true,'REVALIDATING skips the reservation quota');
});
test('a partial fill keeps the cap of the original order size',()=>{
  const groups=[group('a',9),group('b',9),group('c',9)];
  // Original Q=20 -> cap 3 per group. Offering 9 credits works; recomputing the cap from 9 (cap 1) would not.
  const r=allocateFcaeV0(groups,20,{capBasisQ:20,skipQuota:false});
  assert.equal(r.ok===false&&r.offeredCount,9);
  const taken=allocateFcaeV0(groups,20,{take:9,capBasisQ:20,skipQuota:false});
  assert.equal(taken.ok,true);assert.equal(total(taken),9);
  const shrunk=allocateFcaeV0(groups,9,{capBasisQ:9,skipQuota:false});
  assert.equal(shrunk.ok,false,'the wrong basis (9) would have refused the same 9 credits');
});
test('the allocation is a pure function of stored inputs (shuffle-invariant, never over-allocates)',()=>{
  const random=rng(42);
  for(let round=0;round<200;round++){
    const n=1+Math.floor(random()*12);
    const groups=Array.from({length:n},(_,i)=>group(`g${i}`,Math.floor(random()*8),Math.floor(random()*5),Math.floor(random()*6)));
    const q=1+Math.floor(random()*30),capBasisQ=q,skipQuota=random()<0.3;
    const base=allocateFcaeV0(groups,q,{capBasisQ,skipQuota});
    const shuffled=[...groups].sort(()=>random()-0.5).map(g=>({...g,creditIds:[...g.creditIds].sort(()=>random()-0.5)}));
    assert.deepEqual(allocateFcaeV0(shuffled,q,{capBasisQ,skipQuota}),base);
    const cap=capFor(capBasisQ);
    for(const a of base.allocations){
      const g=groups.find(x=>x.groupId===a.groupId)!;
      assert.ok(a.count<=g.available&&a.count<=cap&&a.creditIds.length===a.count);
      if(!skipQuota)assert.ok(a.count<=Math.max(0,quotaFor(g.available,g.reserved)-g.reserved));
    }
    assert.equal(new Set(base.allocations.flatMap(a=>a.creditIds)).size,total(base),'no credit twice');
    if(base.ok)assert.equal(total(base),q);else assert.ok(base.offeredCount<q&&total(base)===base.offeredCount);
  }
});
test('longer waiting wins and ties break on group id',()=>{
  const r=allocateFcaeV0([group('b',5,0,3),group('a',5,0,3),group('c',5,0,9)],2,{capBasisQ:2,skipQuota:false});
  assert.deepEqual(r.allocations.map(a=>a.groupId),['c','a']);
});
test('commission is rounded half-even per line and the remainder is exact',()=>{
  assert.equal(commissionPaise(100030n,500),5002n);   // 5001.5 -> 5002
  assert.equal(commissionPaise(100010n,500),5000n);   // 5000.5 -> 5000
  assert.equal(commissionPaise(0n,500),0n);assert.equal(commissionPaise(12345n,0),0n);assert.equal(commissionPaise(12345n,10000),12345n);
  assert.deepEqual(ledgerLine(100030n,500),{gross:100030n,commission:5002n,net:95028n});
  assert.throws(()=>commissionPaise(-1n,500));assert.throws(()=>commissionPaise(1n,10001));assert.throws(()=>commissionPaise(1n,1.5));
  const big=9_000_000_000_000_000n;assert.equal(commissionPaise(big,500),450_000_000_000_000n,'exact beyond Number.MAX_SAFE_INTEGER');
  const random=rng(7);
  for(let i=0;i<500;i++){
    const gross=BigInt(Math.floor(random()*1e9)),bps=Math.floor(random()*10001),line=ledgerLine(gross,bps);
    assert.equal(line.commission+line.net,gross);assert.ok(line.commission>=0n&&line.net>=0n);
    const exact2=gross*BigInt(bps)*2n,got2=line.commission*20000n;assert.ok(got2-exact2<=10000n&&exact2-got2<=10000n,'within half a paise');
  }
});
