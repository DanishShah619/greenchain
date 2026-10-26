import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SandboxRail} from '../src/modules/payouts/infrastructure/sandbox-rail.js';
import {seedMarket} from './support/market.js';
import {migratedPglite} from './support/pglite.js';
// The deterministic sandbox rail (docs/23 P9): what each token suffix does, idempotency by key, and the call log.
async function setup(){
  const {db}=await migratedPglite();
  const m=await seedMarket(db,{groups:1,perGroup:1});
  return {db,rail:new SandboxRail(db),scenarioId:m.scenario};
}
const token=(suffix:string)=>`SANDBOX-0A1B2C3D-${suffix}`;
const code=(c:string)=>(e:any)=>{assert.equal(e?.code,c);return true;};

test('00 is accepted and settles on the next tick; a resend with the same key is the same transfer',async()=>{
  const {db,rail,scenarioId}=await setup();const key=randomUUID();
  const req={scenarioId,key,accountToken:token('00'),amountPaise:95028n};
  const sent=await rail.send(req);
  assert.equal(sent.kind,'ACCEPTED');
  assert.deepEqual(await rail.getByKey({scenarioId,key}),{kind:'FOUND',status:'PROCESSING',amountPaise:95028n,railRef:(sent as any).railRef});
  assert.deepEqual(await rail.send(req),sent,'idempotent by key');
  await rail.tick(scenarioId);
  assert.equal((await rail.getByKey({scenarioId,key}) as any).status,'SETTLED');
  assert.equal((await rail.send(req)).kind,'SETTLED');
  assert.equal(await rail.voidKey({scenarioId,key}),'ALREADY_PROCESSED');
  assert.equal(await rail.processedTransfers(key),1);
  const calls=(await db.query('SELECT op FROM demo_sandbox_calls WHERE payout_id=$1 ORDER BY id',[key])).rows.map(r=>r.op);
  assert.deepEqual(calls,['send','get','send','get','send','void']);
});

test('a different token or amount under the same key is a conflict, never a second transfer',async()=>{
  const {rail,scenarioId}=await setup();const key=randomUUID();
  await rail.send({scenarioId,key,accountToken:token('00'),amountPaise:100n});
  assert.equal((await rail.send({scenarioId,key,accountToken:token('05'),amountPaise:100n})).kind,'CONFLICT');
  assert.equal((await rail.send({scenarioId,key,accountToken:token('00'),amountPaise:101n})).kind,'CONFLICT');
  assert.equal(await rail.processedTransfers(key),1);
});

test('02 times out and is never processed; 03 times out but was processed',async()=>{
  const {rail,scenarioId}=await setup();
  const a=randomUUID(),b=randomUUID();
  await assert.rejects(rail.send({scenarioId,key:a,accountToken:token('02'),amountPaise:100n}),code('RAIL_TIMEOUT'));
  assert.deepEqual(await rail.getByKey({scenarioId,key:a}),{kind:'NOT_FOUND'});
  await assert.rejects(rail.send({scenarioId,key:a,accountToken:token('02'),amountPaise:100n}),code('RAIL_TIMEOUT'));
  assert.equal(await rail.processedTransfers(a),0);
  assert.equal(await rail.voidKey({scenarioId,key:a}),'VOIDED');
  assert.equal((await rail.send({scenarioId,key:a,accountToken:token('02'),amountPaise:100n})).kind,'REJECTED','a voided key never pays');
  await assert.rejects(rail.send({scenarioId,key:b,accountToken:token('03'),amountPaise:100n}),code('RAIL_TIMEOUT'));
  assert.equal((await rail.getByKey({scenarioId,key:b}) as any).status,'PROCESSING');
  assert.equal(await rail.voidKey({scenarioId,key:b}),'ALREADY_PROCESSED');
});

test('04 fails twice then succeeds; 10 is down for sends, lookups and voids',async()=>{
  const {rail,scenarioId}=await setup();const key=randomUUID(),down=randomUUID();
  const req={scenarioId,key,accountToken:token('04'),amountPaise:100n};
  assert.equal((await rail.send(req)).kind,'TRANSIENT');assert.equal((await rail.send(req)).kind,'TRANSIENT');
  assert.deepEqual(await rail.getByKey({scenarioId,key}),{kind:'NOT_FOUND'},'a transient failure processed nothing');
  assert.equal((await rail.send(req)).kind,'ACCEPTED');
  assert.equal((await rail.send({scenarioId,key:down,accountToken:token('10'),amountPaise:100n})).kind,'TRANSIENT');
  await assert.rejects(rail.getByKey({scenarioId,key:down}),code('RAIL_UNAVAILABLE'));
  await assert.rejects(rail.voidKey({scenarioId,key:down}),code('RAIL_UNAVAILABLE'));
});

test('05 is rejected (nothing paid); 06 is accepted then returned; 12 settles a different amount',async()=>{
  const {rail,scenarioId}=await setup();const r=randomUUID(),ret=randomUUID(),odd=randomUUID();
  assert.equal((await rail.send({scenarioId,key:r,accountToken:token('05'),amountPaise:100n})).kind,'REJECTED');
  assert.equal(await rail.processedTransfers(r),0);assert.equal(await rail.voidKey({scenarioId,key:r}),'VOIDED');
  assert.equal((await rail.send({scenarioId,key:ret,accountToken:token('06'),amountPaise:100n})).kind,'ACCEPTED');
  assert.equal((await rail.send({scenarioId,key:odd,accountToken:token('12'),amountPaise:100n})).kind,'ACCEPTED');
  await rail.tick(scenarioId);
  assert.equal((await rail.getByKey({scenarioId,key:ret}) as any).status,'RETURNED');
  assert.deepEqual([(await rail.getByKey({scenarioId,key:odd}) as any).status,(await rail.getByKey({scenarioId,key:odd}) as any).amountPaise],['SETTLED',101n]);
});

test('11 times out and becomes visible only after three ticks; a void before then stops it',async()=>{
  const {rail,scenarioId}=await setup();const late=randomUUID(),voided=randomUUID();
  for(const key of [late,voided])await assert.rejects(rail.send({scenarioId,key,accountToken:token('11'),amountPaise:100n}),code('RAIL_TIMEOUT'));
  assert.equal(await rail.voidKey({scenarioId,key:voided}),'VOIDED');
  for(let i=0;i<2;i++){await rail.tick(scenarioId);assert.deepEqual(await rail.getByKey({scenarioId,key:late}),{kind:'NOT_FOUND'},`tick ${i+1}`);}
  assert.equal((await rail.send({scenarioId,key:late,accountToken:token('11'),amountPaise:100n})).kind,'ACCEPTED','a resend while invisible is the same transfer');
  assert.equal((await rail.getByKey({scenarioId,key:late}) as any).status,'PROCESSING','once accepted, it can be found');
  await rail.tick(scenarioId);
  assert.equal((await rail.getByKey({scenarioId,key:late}) as any).status,'SETTLED');
  assert.equal(await rail.processedTransfers(late),1);
  assert.equal(await rail.processedTransfers(voided),0);assert.equal((await rail.getByKey({scenarioId,key:voided}) as any).status,'VOIDED');
});
