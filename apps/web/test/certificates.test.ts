import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CERTIFICATE_MESSAGES,isCertificateNumber,proofLine,resetConfirmed,verifyLink,verifyQuery} from '../src/certificates';
test('verification links point at the public verify page with the number and hash, and are parsed back strictly',()=>{
  const h='a'.repeat(64);
  assert.equal(verifyLink('https://demo.example','GC-DEMO-7K4Q-9XW2',h),`https://demo.example/verify.html?n=GC-DEMO-7K4Q-9XW2&h=${h}`);
  assert.deepEqual(verifyQuery(`?n=GC-DEMO-7K4Q-9XW2&h=${h}`),{number:'GC-DEMO-7K4Q-9XW2',hash:h});
  assert.deepEqual(verifyQuery('?n=GC-DEMO-7K4Q-9XW2'),{number:'GC-DEMO-7K4Q-9XW2',hash:null});
  assert.deepEqual(verifyQuery('?n=GC-DEMO-7K4Q-9XW2&h=nothex'),{number:'GC-DEMO-7K4Q-9XW2',hash:null},'a malformed hash is ignored, not sent');
  assert.deepEqual(verifyQuery('?n=../../etc'),{number:null,hash:null});
  assert.ok(isCertificateNumber('GC-DEMO-0123-ABCD'));assert.ok(!isCertificateNumber('GC-DEMO-0I23-ABCD'),'no I');assert.ok(!isCertificateNumber('gc-demo-0123-abcd'));
});
test('chain proofs read plainly, with a testnet link only for a well-formed Amoy transaction',()=>{
  const tx=`0x${'ab'.repeat(32)}`;
  assert.deepEqual(proofLine({group:'Group 0A1B2C',status:'CONFIRMED',network:80002,transactionHash:tx}),{text:'Group 0A1B2C: recorded on Polygon Amoy (testnet)',href:`https://amoy.polygonscan.com/tx/${tx}`});
  assert.deepEqual(proofLine({group:'Group 0A1B2C',status:'PENDING'}),{text:'Group 0A1B2C: blockchain proof pending',href:null});
  assert.equal(proofLine({group:'G',status:'CONFIRMED',network:80002,transactionHash:'javascript:alert(1)'}).href,null);
});
test('a reset needs the exact word RESET, and certificate errors read plainly',()=>{
  assert.equal(resetConfirmed('RESET'),true);for(const no of ['reset','RESET ',' RESET','','RESETS'])assert.equal(resetConfirmed(no),false,no);
  for(const code of ['ORDER_NOT_FULFILLED','CERTIFICATE_NOT_ISSUED','SCENARIO_RETIRED','RATE_LIMITED','NOT_FOUND'])assert.ok(CERTIFICATE_MESSAGES[code],code);
});
