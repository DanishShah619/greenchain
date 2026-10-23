import {test} from 'node:test';
import assert from 'node:assert/strict';
import {earningJournals,journal,payoutBatched,payoutReversed,payoutSettled,payloadHash} from '../src/modules/payouts/domain/postings.js';
import {canMovePayout,lotEventAllowed,PAYOUT_STATES,FINAL_PAYOUT_STATES} from '../src/modules/payouts/domain/state.js';
import {backoffSeconds,withDeadline} from '../src/kernel/retry.js';
const P='11111111-1111-4111-8111-111111111111';
const sum=(lines:{side:string;amountPaise:bigint}[],side:string)=>lines.filter(l=>l.side===side).reduce((n,l)=>n+l.amountPaise,0n);
test('golden earnings (doc 11 worked example): E1 splits gross into payable and commission; E2 funds the reserve half-even',()=>{
  const a=earningJournals({ledgerEntryId:'1',payeeGroupId:P,grossPaise:100030n,commissionPaise:5002n,netPaise:95028n,reserveBps:2000});
  assert.equal(a.earned.key,'EARN:1');assert.equal(a.earned.totalPaise,100030n);
  assert.deepEqual(a.earned.lines.map(l=>[l.account,l.side,l.amountPaise,l.payeeGroupId??null]),[['buyer_funds_clearing','DR',100030n,null],['payee_payable','CR',95028n,P],['commission_revenue','CR',5002n,null]]);
  assert.equal(a.reservePaise,1000n,'5002 x 20% = 1000.4 -> 1000');assert.equal(a.funded?.key,'FUND:1');assert.equal(a.funded?.basisBps,2000,'the reserve journal records its basis');assert.equal(a.earned.basisBps,undefined);
  assert.deepEqual(a.funded?.lines.map(l=>[l.account,l.side,l.amountPaise]),[['commission_revenue','DR',1000n],['reversal_reserve','CR',1000n]]);
  const b=earningJournals({ledgerEntryId:'2',payeeGroupId:P,grossPaise:100010n,commissionPaise:5000n,netPaise:95010n,reserveBps:2000});
  assert.equal(b.reservePaise,1000n);
  for(const j of [a.earned,a.funded!,b.earned,b.funded!])assert.equal(sum(j.lines,'DR'),sum(j.lines,'CR'));
});
test('reserve funding rounds half-even on exact ties',()=>{
  const reserve=(c:bigint,bps:number)=>earningJournals({ledgerEntryId:'x',payeeGroupId:P,grossPaise:c+1n,commissionPaise:c,netPaise:1n,reserveBps:bps}).reservePaise;
  assert.equal(reserve(4n,1250),0n,'0.5 -> 0 (even)');assert.equal(reserve(12n,1250),2n,'1.5 -> 2');
  assert.equal(reserve(5001n,5000),2500n,'2500.5 -> 2500');assert.equal(reserve(5003n,5000),2502n,'2501.5 -> 2502');
});
test('zero amounts never produce a zero line: 0% and 100% commission and a tiny reserve still post',()=>{
  const none=earningJournals({ledgerEntryId:'z1',payeeGroupId:P,grossPaise:1000n,commissionPaise:0n,netPaise:1000n,reserveBps:2000});
  assert.deepEqual(none.earned.lines.map(l=>l.account),['buyer_funds_clearing','payee_payable']);assert.equal(none.funded,null);assert.equal(none.reservePaise,0n);
  const all=earningJournals({ledgerEntryId:'z2',payeeGroupId:P,grossPaise:1000n,commissionPaise:1000n,netPaise:0n,reserveBps:2000});
  assert.deepEqual(all.earned.lines.map(l=>l.account),['buyer_funds_clearing','commission_revenue'],'no payable line when net is 0');
  const tiny=earningJournals({ledgerEntryId:'z3',payeeGroupId:P,grossPaise:1002n,commissionPaise:2n,netPaise:1000n,reserveBps:2000});
  assert.equal(tiny.funded,null,'2 x 20% rounds to 0: no reserve journal');
  assert.throws(()=>earningJournals({ledgerEntryId:'bad',payeeGroupId:P,grossPaise:100n,commissionPaise:10n,netPaise:80n,reserveBps:2000}),'gross must equal commission + net');
  assert.throws(()=>earningJournals({ledgerEntryId:'bad',payeeGroupId:P,grossPaise:100n,commissionPaise:0n,netPaise:100n,reserveBps:10001}));
});
test('payout journals: batch, settle and reverse balance and carry the payee only on payable lines',()=>{
  const id='22222222-2222-4222-8222-222222222222';
  const pb=payoutBatched(id,P,190038n),ps=payoutSettled(id,190038n),pc=payoutReversed(id,P,190038n);
  assert.deepEqual([pb.key,ps.key,pc.key],[`PB:${id}`,`PS:${id}`,`PC:${id}`]);
  assert.deepEqual(pb.lines.map(l=>[l.account,l.side,l.payeeGroupId??null]),[['payee_payable','DR',P],['payout_clearing','CR',null]]);
  assert.deepEqual(ps.lines.map(l=>[l.account,l.side]),[['payout_clearing','DR'],['bank_cash','CR']]);
  assert.deepEqual(pc.lines.map(l=>[l.account,l.side,l.payeeGroupId??null]),[['payout_clearing','DR',null],['payee_payable','CR',P]]);
  assert.throws(()=>payoutBatched(id,P,0n));
});
test('a journal refuses imbalance, keeps a stable payload hash, and has no line of zero',()=>{
  assert.throws(()=>journal('EARNED','k',[{account:'buyer_funds_clearing',side:'DR',amountPaise:10n},{account:'commission_revenue',side:'CR',amountPaise:9n}]),/balance/);
  assert.equal(journal('EARNED','k',[{account:'buyer_funds_clearing',side:'DR',amountPaise:0n},{account:'commission_revenue',side:'CR',amountPaise:0n}]),null,'nothing to post');
  const lines=[{account:'payout_clearing',side:'DR',amountPaise:5n},{account:'bank_cash',side:'CR',amountPaise:5n}] as const;
  assert.equal(payloadHash('PAYOUT_SETTLED',[...lines]),payloadHash('PAYOUT_SETTLED',[...lines]));
  assert.notEqual(payloadHash('PAYOUT_SETTLED',[...lines]),payloadHash('PAYOUT_SETTLED',[{...lines[0],amountPaise:6n},{...lines[1],amountPaise:6n}]));
});
test('payout state machine (docs/23 P10): settled, returned and cancelled are final; cancel needs confirmed non-payment',()=>{
  assert.deepEqual([...FINAL_PAYOUT_STATES].sort(),['CANCELLED','RETURNED','SETTLED']);
  const ok=(from:any,to:any,confirmed=false)=>canMovePayout(from,to,{nonPaymentConfirmed:confirmed});
  assert.ok(ok('PENDING','IN_SETTLEMENT'));assert.ok(ok('IN_SETTLEMENT','INDETERMINATE'));assert.ok(ok('INDETERMINATE','IN_SETTLEMENT'),'resend after NOT_FOUND');
  assert.ok(ok('SENT','SETTLED'));assert.ok(ok('SENT','RETURNED'));assert.ok(ok('UNRESOLVED','SETTLED'),'a late FOUND still settles');
  assert.ok(!ok('PENDING','CANCELLED',true),'nothing was sent, but cancel is only for confirmed-unpaid review cases');
  assert.ok(!ok('NEEDS_REVIEW','CANCELLED',false));assert.ok(ok('NEEDS_REVIEW','CANCELLED',true));assert.ok(ok('UNRESOLVED','CANCELLED',true));
  assert.ok(!ok('INDETERMINATE','CANCELLED',true),'unknown outcomes are resolved first');
  assert.ok(!ok('NEEDS_REVIEW','SETTLED',true)&&!ok('UNRESOLVED','SENT',true),'money confirmed unpaid is never later sent or settled');
  for(const final of FINAL_PAYOUT_STATES)for(const to of PAYOUT_STATES)if(to!==final)assert.ok(!ok(final,to,true),`${final} -> ${to}`);
});
test('lot events: earned, batched, then paid or released; a released lot can be batched again',()=>{
  assert.ok(lotEventAllowed(null,'EARNED'));assert.ok(!lotEventAllowed(null,'IN_BATCH'));
  assert.ok(lotEventAllowed('EARNED','IN_BATCH'));assert.ok(lotEventAllowed('IN_BATCH','PAID'));assert.ok(lotEventAllowed('IN_BATCH','RELEASED'));
  assert.ok(lotEventAllowed('RELEASED','IN_BATCH'));assert.ok(!lotEventAllowed('EARNED','PAID'));assert.ok(!lotEventAllowed('PAID','RELEASED'));
});
test('kernel backoff and deadline are generic (the chain worker keeps its behaviour through them)',async()=>{
  assert.equal(backoffSeconds(1,5,3600,()=>0.5),5);assert.equal(backoffSeconds(3,5,3600,()=>0.5),20);assert.equal(backoffSeconds(30,5,3600,()=>0.5),3600);
  assert.equal(backoffSeconds(1,5,3600,()=>0),4);assert.equal(backoffSeconds(1,5,3600,()=>1),6);
  await assert.rejects(withDeadline(new Promise(()=>{}),20,'PAYOUT_CALL_TIMEOUT'),/PAYOUT_CALL_TIMEOUT/);
  assert.equal(await withDeadline(Promise.resolve(7),50,'X'),7);
});
