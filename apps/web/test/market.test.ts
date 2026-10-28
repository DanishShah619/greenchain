import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatPaise,quotePaise,holdCountdown,remaining,stateLabel,isSettling,ORDER_STATE_LABELS} from '../src/market';
test('paise are formatted exactly, in Indian digit grouping, without floating point',()=>{
  assert.equal(formatPaise('100030'),'₹1,000.30');
  assert.equal(formatPaise('2000600'),'₹20,006.00');
  assert.equal(formatPaise('5'),'₹0.05');assert.equal(formatPaise('0'),'₹0.00');
  assert.equal(formatPaise('123456789012'),'₹1,23,45,67,890.12');
  assert.equal(formatPaise('900719925474099312'),'₹9,00,71,99,25,47,40,993.12','beyond Number.MAX_SAFE_INTEGER');
  assert.equal(formatPaise('-150'),'−₹1.50');
  for(const bad of [null,undefined,'','1.5','abc'])assert.equal(formatPaise(bad as any),'—');
});
test('quotes multiply exactly and refuse bad input',()=>{
  assert.equal(quotePaise('100030',20),'2000600');assert.equal(quotePaise('100030',0),'0');
  assert.equal(quotePaise('x',2),'0');assert.equal(quotePaise('100',1.5),'0');
});
test('the reservation countdown shows minutes and seconds and ends at zero',()=>{
  const now=Date.parse('2026-10-22T10:00:00Z');
  assert.equal(remaining('2026-10-22T10:04:05Z',now),'4:05');
  assert.equal(remaining('2026-10-22T10:00:00Z',now),null);assert.equal(remaining(null,now),null);
});
test('the hold countdown shows only while credits are held: a paid order keeps reservedUntil but shows no countdown',()=>{
  const now=Date.parse('2026-10-22T10:00:00Z'),until='2026-10-22T10:01:48Z';
  assert.equal(holdCountdown('RESERVED',until,now),'1:48');
  assert.equal(holdCountdown('AWAITING_PAYMENT',until,now),'1:48');
  for(const state of Object.keys(ORDER_STATE_LABELS).filter(s=>!['RESERVED','AWAITING_PAYMENT'].includes(s)))
    assert.equal(holdCountdown(state,until,now),null,state);
  assert.equal(holdCountdown('RESERVED','2026-10-22T09:59:00Z',now),null);
});
test('every order state has a buyer-facing label; settling states are the ones that change without the buyer',()=>{
  for(const s of ['CREATED','RESERVED','AWAITING_PAYMENT','FULFILLED','CANCELLED','EXPIRED','REVALIDATING','REFUND_PENDING','REFUNDED'])assert.ok(ORDER_STATE_LABELS[s],s);
  assert.equal(stateLabel('SOMETHING_NEW'),'something new');
  assert.deepEqual(['AWAITING_PAYMENT','FULFILLED','REFUND_PENDING','RESERVED'].map(isSettling),[true,false,true,false]);
});
test('quantity text is parsed, never coerced: empty or invalid input is "no quantity", not 1 or 0',async()=>{
  const {parseQuantity}=await import('../src/market');
  assert.deepEqual(['1','12','100',' 7 '].map(parseQuantity),[1,12,100,7]);
  for(const bad of ['','0','101','2.5','-3','1e2','abc','12a'])assert.equal(parseQuantity(bad),null,JSON.stringify(bad));
});
