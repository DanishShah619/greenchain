import {test} from 'node:test';
import assert from 'node:assert/strict';
import {batchMessage,bpsToPercent,clockLabel,inFlight,labelCode,lineStateLabel,PAYOUT_MESSAGES,PAYOUT_STATE_LABELS,paiseToRupeesInput,percentToBps,rupeesToPaise,SANDBOX_CHOICES} from '../src/payouts';
test('rupee amounts become exact paise and back, never through floating point',()=>{
  assert.equal(rupeesToPaise('100'),'10000');assert.equal(rupeesToPaise('100.5'),'10050');assert.equal(rupeesToPaise('100.05'),'10005');
  assert.equal(rupeesToPaise(' 50000 '),'5000000');assert.equal(rupeesToPaise('9999999999999.99'),'999999999999999');
  for(const bad of ['','0','0.00','-1','1.234','1e3','abc','1,000','.5'])assert.equal(rupeesToPaise(bad),null,bad);
  assert.equal(paiseToRupeesInput('10000'),'100.00');assert.equal(paiseToRupeesInput('10005'),'100.05');assert.equal(paiseToRupeesInput('5'),'0.05');
});
test('reserve share is entered as a percentage and stored as basis points',()=>{
  assert.equal(percentToBps('20'),2000);assert.equal(percentToBps('12.5'),1250);assert.equal(percentToBps('0'),0);assert.equal(percentToBps('100'),10000);assert.equal(percentToBps('0.01'),1);
  for(const bad of ['','100.01','-5','12.345','abc'])assert.equal(percentToBps(bad),null,bad);
  assert.equal(bpsToPercent(2000),'20%');assert.equal(bpsToPercent(1250),'12.5%');assert.equal(bpsToPercent(1),'0.01%');
});
test('statement lines explain where the money is, with the holdback date for held lots',()=>{
  assert.equal(lineStateLabel('HELD','2026-11-03T10:00:00.000Z'),'Held until 3 Nov 2026 (first-payout holdback)');
  assert.equal(lineStateLabel('RELEASABLE',null),'Ready for the next payout');
  assert.equal(lineStateLabel('IN_PAYOUT',null),'In a payout');assert.equal(lineStateLabel('PAID',null),'Paid');
  assert.equal(lineStateLabel('NO_NET',null),'Nothing to pay (all commission)');
  for(const s of ['PENDING','IN_SETTLEMENT','SENT','SETTLED','RETRY','INDETERMINATE','UNRESOLVED','NEEDS_REVIEW','RETURNED','CANCELLED'])assert.ok(PAYOUT_STATE_LABELS[s],s);
});
test('the demo clock reads as an offset from real time',()=>{
  assert.equal(clockLabel(0),'Real time');assert.equal(clockLabel(3600),'1 hour ahead');assert.equal(clockLabel(7*86400),'7 days ahead');
  assert.equal(clockLabel(7*86400+2*3600),'7 days, 2 hours ahead');assert.equal(clockLabel(86400+60),'1 day ahead');
});
test('labels, suffix choices, polling and error messages',()=>{
  assert.equal(labelCode('Group 0A1B2C'),'0A1B2C');assert.equal(labelCode('nonsense'),null);
  assert.deepEqual(SANDBOX_CHOICES.map(c=>c.suffix),['00','02','03','04','05','06','10','11','12']);
  assert.ok(SANDBOX_CHOICES.every(c=>c.label.length>3));
  assert.equal(inFlight([{state:'SETTLED'},{state:'NEEDS_REVIEW'},{state:'CANCELLED'}]),false,'nothing will change without the presenter');
  assert.equal(inFlight([{state:'SETTLED'},{state:'SENT'}]),true);assert.equal(inFlight([{state:'PENDING'}]),true);
  for(const code of ['CLOCK_CONFLICT','CLOCK_LIMIT','PAYOUT_MAY_BE_PAID','PAYOUT_NOT_CANCELLABLE','PAYOUT_PROCESSED','RAIL_UNAVAILABLE','VALIDATION_FAILED','BATCH_CONFLICT','SCENARIO_EMPTY'])assert.ok(PAYOUT_MESSAGES[code],code);
});
test('a payout run explains itself, including a run that found nothing to pay',()=>{
  assert.equal(batchMessage({replayed:false,runSeq:2,runDate:'2026-11-03',payouts:3,rolledOver:1,skippedReverify:0}),'Payout run 2 for 2026-11-03: 3 payouts created, 1 below the minimum carried over.');
  assert.equal(batchMessage({replayed:false,runSeq:1,runDate:'2026-11-03',payouts:1,rolledOver:0,skippedReverify:2}),'Payout run 1 for 2026-11-03: 1 payout created, 2 waiting for re-verification.');
  assert.match(batchMessage({replayed:false,runSeq:1,runDate:'2026-11-03',payouts:0,rolledOver:0,skippedReverify:0}),/Nothing new to pay.*held.*daily run/);
  assert.equal(batchMessage({replayed:true,runSeq:1,runDate:'2026-11-03',payouts:0,rolledOver:0,skippedReverify:0}),'That payout run had already been made.');
});
