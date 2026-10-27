import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../src/bootstrap/app.js';
import {marketConfig} from '../src/bootstrap/config.js';
import {hashPassword} from '../src/kernel/password.js';
import {seedDemoMarket,MARKET_SEED_ACTOR} from '../src/modules/market/application/seed.js';
import {DEFAULT_MARKET} from '../src/modules/market/application/orders.js';
import {DEFAULT_PAYMENTS} from '../src/modules/market/application/payments.js';
import {runSettlementCycle} from '../src/modules/payouts/application/settlement.js';
import {SandboxRail} from '../src/modules/payouts/infrastructure/sandbox-rail.js';
import {migratedPglite} from './support/pglite.js';
import {requirePresenter} from '../src/kernel/presenter.js';
// Payout routes (docs/23 §6.4): the presenter guard (P11), presenter controls with audit and CSRF, and the owner-only statement
// (P12) without identifying data (§9).
const origin='http://localhost:3000',password='test-password-for-demo-123',secret='test-webhook-secret-of-at-least-32-chars';
type Headers=Record<string,string>;
async function fixture(o:{demoMode?:boolean}={}){
  const {pg,db}=await migratedPglite();
  for(const s of ['presenter','showcase','other'])await db.query('INSERT INTO scenarios(id) VALUES ($1)',[s]),await db.query('INSERT INTO demo_namespaces(scenario_id) VALUES ($1)',[s]);
  for(const [id,scenario,role] of [['presenter','presenter','agent'],['agent-2','presenter','agent'],['verifier','presenter','verifier'],['buyer','presenter','buyer'],
    [MARKET_SEED_ACTOR,'presenter','agent'],['show-presenter','showcase','agent'],['other-presenter','other','agent']])
    await db.query('INSERT INTO users(id,scenario_id,role,password_hash) VALUES ($1,$2,$3,$4)',[id,scenario,role,hashPassword(password)]);
  await seedDemoMarket(db,{scenarioId:'presenter',groups:4,perGroup:10});
  const app=await buildApp(db,{origin,secure:false,market:{market:DEFAULT_MARKET,payments:{...DEFAULT_PAYMENTS,secrets:[secret]},demoMode:o.demoMode??true,presenterIds:['presenter','show-presenter','other-presenter','verifier']}});
  async function session(userId:string):Promise<Headers>{
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
    await db.query(`INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`,[createHash('sha256').update(token).digest('hex'),userId,csrf]);
    return {origin,cookie:`session=${token}`,'x-csrf-token':csrf};
  }
  const send=(method:'GET'|'POST'|'PUT',url:string,headers:Headers,payload?:unknown)=>app.inject({method,url:'/api/v1'+url,headers,...(payload===undefined?{}:{payload:payload as any})});
  const who={presenter:await session('presenter'),agent2:await session('agent-2'),verifier:await session('verifier'),buyer:await session('buyer'),owner:await session(MARKET_SEED_ACTOR),showcase:await session('show-presenter'),otherPresenter:await session('other-presenter')};
  /** A sale through the routes: buyer orders and pays, the presenter simulates the provider's success. */
  async function sell(quantity=2){
    const order=(await send('POST','/orders',who.buyer,{requestId:randomUUID(),quantity})).json();
    assert.equal((await send('POST',`/orders/${order.order.id}/payment-attempts`,who.buyer,{acceptSnapshotHash:order.snapshotHash})).statusCode,200);
    assert.equal((await send('POST',`/demo/orders/${order.order.id}/simulate`,who.presenter,{outcome:'success'})).json().outcome,'FULFILLED');
    return order.order.id as string;
  }
  const audits=async()=>(await db.query(`SELECT event_type FROM audit_events WHERE event_type LIKE 'payouts.%' ORDER BY created_at`)).rows.map(r=>r.event_type as string);
  return {db,app,send,who,sell,audits,close:async()=>{await app.close();await pg.close();}};
}
/** Strings that identify a farmer, a case, a buyer or a bank-like account; none may appear in a statement or the panel. */
async function secrets(db:any){
  const ids=(await db.query(`SELECT event_id::text AS id FROM captures`)).rows.map((r:any)=>r.id);
  const orders=(await db.query(`SELECT id::text AS id FROM demo_orders`)).rows.map((r:any)=>r.id);
  return [...ids,...orders,'Market seed farmer','Synthetic village','SANDBOX-','SBX-','buyer'];
}
const leaks=(body:string,forbidden:string[])=>forbidden.filter(s=>body.includes(s));

test('only an allow-listed presenter in a demo scenario other than showcase may use presenter controls, including the simulator',async()=>{
  const f=await fixture();
  try{
    const orderId=await f.sell(1);
    const routes:[ 'GET'|'POST'|'PUT',string,unknown][]=[['GET','/demo/payouts',undefined],['POST','/demo/clock',{expectedOffsetSeconds:0,advanceSeconds:60}],
      ['POST','/demo/payouts/batch',{requestId:randomUUID()}],['PUT','/demo/ledger-config',{holdbackDays:0,reserveBps:2000,minPayoutPaise:'10000',payoutLimitPaise:'5000000'}],
      ['POST','/demo/payees/ABCDEF/sandbox',{suffix:'05'}],['POST',`/demo/payouts/${randomUUID()}/cancel`,{requestId:randomUUID(),reason:'Confirmed unpaid'}],
      ['GET','/demo/orders',undefined],['GET','/demo/invariants',undefined],['POST',`/demo/orders/${orderId}/simulate`,{outcome:'replay'}]];
    for(const [method,url,body] of routes)for(const [name,headers] of Object.entries({agent2:f.who.agent2,verifier:f.who.verifier,buyer:f.who.buyer,showcase:f.who.showcase})){
      const r=await f.send(method,url,headers,body);
      assert.equal(r.statusCode,403,`${name} ${method} ${url}: ${r.body}`);
    }
    assert.equal((await f.send('GET','/demo/payouts',f.who.presenter)).statusCode,200);
    assert.equal((await f.send('GET','/demo/orders',f.who.presenter)).statusCode,200);
  }finally{await f.close();}
});

test('presenter controls: clock by compare-and-set, config versions, batches replayed by request id, all audited and CSRF-protected',async()=>{
  const f=await fixture();
  try{
    await f.sell(2);
    const {'x-csrf-token':_,...noCsrf}=f.who.presenter;
    assert.equal((await f.send('POST','/demo/clock',noCsrf,{expectedOffsetSeconds:0,advanceSeconds:60})).statusCode,403);
    const clock=await f.send('POST','/demo/clock',f.who.presenter,{expectedOffsetSeconds:0,advanceSeconds:7*86400});
    assert.equal(clock.statusCode,200,clock.body);assert.equal(clock.json().offsetSeconds,7*86400);
    assert.equal((await f.send('POST','/demo/clock',f.who.presenter,{expectedOffsetSeconds:0,advanceSeconds:60})).json().code,'CLOCK_CONFLICT');
    assert.equal((await f.send('POST','/demo/clock',f.who.presenter,{expectedOffsetSeconds:7*86400,advanceSeconds:0})).statusCode,400);
    const config=await f.send('PUT','/demo/ledger-config',f.who.presenter,{holdbackDays:0,reserveBps:1500,minPayoutPaise:'10000',payoutLimitPaise:'5000000'});
    assert.equal(config.statusCode,200,config.body);assert.equal(config.json().version,1);
    assert.equal((await f.send('PUT','/demo/ledger-config',f.who.presenter,{holdbackDays:0,reserveBps:10001,minPayoutPaise:'10000',payoutLimitPaise:'5000000'})).statusCode,400);
    assert.equal((await f.send('PUT','/demo/ledger-config',f.who.presenter,{holdbackDays:0,reserveBps:1500,minPayoutPaise:'50000',payoutLimitPaise:'10000'})).json().code,'VALIDATION_FAILED');
    const requestId=randomUUID();
    const batch=await f.send('POST','/demo/payouts/batch',f.who.presenter,{requestId});
    assert.equal(batch.statusCode,200,batch.body);assert.ok(batch.json().payouts>=1,'held 7 days, now releasable');assert.equal(batch.json().replayed,false);
    const again=(await f.send('POST','/demo/payouts/batch',f.who.presenter,{requestId})).json();
    assert.deepEqual([again.batchId,again.replayed,again.payouts],[batch.json().batchId,true,0]);
    assert.deepEqual(await f.audits(),['payouts.clock.advanced','payouts.config.changed','payouts.batch.run']);
  }finally{await f.close();}
});

test('the presenter changes a payee\'s sandbox suffix by label, and cancels only a confirmed-unpaid payout',async()=>{
  const f=await fixture();
  try{
    await f.send('PUT','/demo/ledger-config',f.who.presenter,{holdbackDays:0,reserveBps:2000,minPayoutPaise:'10000',payoutLimitPaise:'5000000'});
    await f.sell(1);
    const panel=(await f.send('GET','/demo/payouts',f.who.presenter)).json();
    const payee=panel.payees.find((p:any)=>BigInt(p.payablePaise)>0n);
    assert.match(payee.label,/^Group [0-9A-F]{6}$/);assert.equal(payee.suffix,'00');
    const code=payee.label.slice(6);
    assert.equal((await f.send('POST','/demo/payees/000000/sandbox',f.who.presenter,{suffix:'05'})).statusCode,404);
    assert.equal((await f.send('POST',`/demo/payees/${code}/sandbox`,f.who.presenter,{suffix:'99'})).statusCode,400);
    assert.equal((await f.send('POST',`/demo/payees/${code}/sandbox`,f.who.presenter,{suffix:'05'})).statusCode,200);
    await f.send('POST','/demo/payouts/batch',f.who.presenter,{requestId:randomUUID()});
    const pending=(await f.send('GET','/demo/payouts',f.who.presenter)).json().payouts[0];
    assert.equal((await f.send('POST',`/demo/payouts/${pending.id}/cancel`,f.who.otherPresenter,{requestId:randomUUID(),reason:'Wrong scenario'})).statusCode,404,'a presenter acts only in its own scenario');
    assert.equal((await f.send('POST',`/demo/payouts/${pending.id}/cancel`,f.who.presenter,{requestId:randomUUID(),reason:'Not sent yet'})).json().code,'PAYOUT_NOT_CANCELLABLE');
    await runSettlementCycle(f.db,'presenter',{rail:new SandboxRail(f.db)});
    const rejected=(await f.send('GET','/demo/payouts',f.who.presenter)).json();
    assert.equal(rejected.payouts[0].state,'NEEDS_REVIEW');assert.equal(rejected.payouts[0].cancellable,true);
    assert.equal(rejected.payees.find((p:any)=>p.label===payee.label).reverifyRequired,true);
    const cancelled=await f.send('POST',`/demo/payouts/${pending.id}/cancel`,f.who.presenter,{requestId:randomUUID(),reason:'Beneficiary rejected'});
    assert.equal(cancelled.statusCode,200,cancelled.body);assert.equal(cancelled.json().state,'CANCELLED');
    // A suffix change is also the re-verification: it clears the flag.
    await f.send('POST',`/demo/payees/${code}/sandbox`,f.who.presenter,{suffix:'00'});
    assert.equal((await f.send('GET','/demo/payouts',f.who.presenter)).json().payees.find((p:any)=>p.label===payee.label).reverifyRequired,false);
    assert.deepEqual(await f.audits(),['payouts.config.changed','payouts.payee.sandbox','payouts.batch.run','payouts.payout.cancelled','payouts.payee.sandbox']);
    const body=(await f.send('GET','/demo/payouts',f.who.presenter)).body;
    assert.deepEqual(leaks(body,(await secrets(f.db)).filter(s=>s!=='buyer')),[],'the panel shows labels and suffixes only');
  }finally{await f.close();}
});

test('a statement is for the agent who owns the case: gross, commission, net, reserve share, lots, payouts, balance, nothing identifying',async()=>{
  const f=await fixture();
  try{
    await f.sell(3);
    const caseId=(await f.db.query('SELECT payee_group_id::text AS p FROM demo_ledger_entries ORDER BY id LIMIT 1')).rows[0].p as string;
    await f.db.query('INSERT INTO review_cases(scenario_id,capture_id) VALUES ($1,$2)',['presenter',caseId]);
    const r=await f.send('GET',`/cases/${caseId}/statement`,f.who.owner);
    assert.equal(r.statusCode,200,r.body);
    const s=r.json();
    assert.equal(s.namespace,'DEMO_ONLY');assert.match(s.label,/^Group [0-9A-F]{6}$/);
    assert.ok(s.lines.length>=1);
    for(const l of s.lines){
      assert.equal(BigInt(l.grossPaise),BigInt(l.commissionPaise)+BigInt(l.netPaise));
      assert.equal(l.reserveSharePaise,'1000');assert.equal(l.state,'HELD','first-time payee: held for the holdback');
    }
    assert.equal(s.payableBalancePaise,String(s.lines.reduce((n:bigint,l:any)=>n+BigInt(l.netPaise),0n)));
    assert.deepEqual(s.payouts,[]);
    assert.deepEqual(leaks(r.body,await secrets(f.db)),[],'no capture labels, villages, case/order ids, tokens, rail refs or buyer ids');
    assert.equal((await f.send('GET',`/cases/${caseId}/statement`,f.who.agent2)).statusCode,404,'another agent');
    assert.equal((await f.send('GET',`/cases/${caseId}/statement`,f.who.verifier)).statusCode,403,'verifiers do not see statements');
    assert.equal((await f.send('GET',`/cases/${caseId}/statement`,f.who.buyer)).statusCode,403);
  }finally{await f.close();}
});

test('without demo mode the presenter payout controls do not exist; the presenter allow-list comes from DEMO_PRESENTER_IDS',async()=>{
  const f=await fixture({demoMode:false});
  try{
    assert.equal((await f.send('GET','/demo/payouts',f.who.presenter)).statusCode,404);
    // Defence in depth: even if a presenter route were reachable, the guard itself refuses without demo mode.
    await assert.rejects(requirePresenter(f.db,{id:'presenter',role:'agent',scenarioId:'presenter'},{demoMode:false,presenterIds:['presenter'],publicScenarioId:'showcase'}),(e:any)=>e.code==='FORBIDDEN');
    await requirePresenter(f.db,{id:'presenter',role:'agent',scenarioId:'presenter'},{demoMode:true,presenterIds:['presenter'],publicScenarioId:'showcase'});
  }finally{await f.close();}
  assert.deepEqual(marketConfig({DEMO_MODE:'true'}).presenterIds,['presenter']);
  assert.deepEqual(marketConfig({DEMO_MODE:'true',DEMO_PRESENTER_IDS:'presenter, host-2'}).presenterIds,['presenter','host-2']);
  assert.throws(()=>marketConfig({DEMO_PRESENTER_IDS:'bad id!'}));
});

test('the presenter invariant report includes the payout ledger',async()=>{
  const f=await fixture();
  try{
    await f.sell(1);
    const report=(await f.send('GET','/demo/invariants',f.who.presenter)).json();
    assert.deepEqual(report.violations,[]);assert.deepEqual(report.payoutViolations,[]);
  }finally{await f.close();}
});
