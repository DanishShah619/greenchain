import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chainAudit,verifyAuditFull} from '../src/modules/audit/application/audit.js';
import {assertMarketInvariants} from '../src/modules/market/application/invariants.js';
import {createOrder} from '../src/modules/market/application/orders.js';
import {DEFAULT_PAYMENTS,handlePaymentEvent} from '../src/modules/market/application/payments.js';
import {eventBody,signedDelivery} from '../src/modules/market/infrastructure/simulator.js';
import {assertPayoutInvariants} from '../src/modules/payouts/application/invariants.js';
import {newPayoutSweepState,payoutSweep} from '../src/modules/payouts/application/sweep.js';
import {SandboxRail} from '../src/modules/payouts/infrastructure/sandbox-rail.js';
import {resetPresenterScenario} from '../src/modules/demo/application/reset.js';
import {requirePresenter} from '../src/kernel/presenter.js';
import {PRICE} from './support/market.js';
import {demoApp,webhookSecret} from './support/demo-app.js';
// The safe presenter reset (docs/24 R1-R6): rotation into a freshly seeded scenario, never deletion.
const reset=(f:Awaited<ReturnType<typeof demoApp>>,presenter:Record<string,string>,o:{requestId?:string;confirm?:string}={})=>
  f.send('POST','/demo/reset',presenter,{requestId:o.requestId??randomUUID(),confirm:o.confirm??'RESET'});
const scenarioOf=async(f:{db:any},user:string)=>(await f.db.query('SELECT scenario_id FROM users WHERE id=$1',[user])).rows[0].scenario_id as string;
const tables=['demo_orders','demo_ledger_entries','demo_journal_entries','demo_earning_lots','demo_payment_events','captures'];

test('a reset rotates the scenario\'s accounts into a freshly seeded scenario and retires the old one, deleting nothing',async()=>{
  const f=await demoApp();
  try{
    const presenter=await f.session('presenter'),buyer=await f.session('buyer');
    await f.sell(buyer,presenter,2);
    const before:Record<string,number>={};for(const t of tables)before[t]=await f.count(`SELECT count(*)::int AS n FROM ${t} WHERE scenario_id='presenter'`);
    const r=await reset(f,presenter);
    assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json(),{namespace:'DEMO_ONLY',scenarioId:'presenter-r2',replayed:false,signInAgain:true});
    assert.equal((await f.send('GET','/demo/payouts',presenter)).statusCode,401,'every session of the moved accounts is revoked');
    for(const u of ['presenter','agent-2','verifier','buyer','buyer-2'])assert.equal(await scenarioOf(f,u),'presenter-r2',u);
    assert.equal(await scenarioOf(f,'show-presenter'),'showcase','the showcase is untouched');
    assert.equal(await scenarioOf(f,'presenter-market-reviewer'),'presenter','the seed reviewer stays with the reviews it signed');
    assert.equal(await scenarioOf(f,'presenter-r2-market-reviewer'),'presenter-r2','the new scenario has its own');
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM review_mandates WHERE user_id='verifier' AND scenario_id='presenter-r2'`),1);
    // The new scenario is in its documented starting state.
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM demo_credits c JOIN demo_issuance_batches b ON b.id=c.batch_id WHERE b.scenario_id='presenter-r2' AND c.state='AVAILABLE'`),200);
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM demo_price_list WHERE scenario_id='presenter-r2'`),1);
    for(const t of ['demo_orders','demo_ledger_entries','demo_payouts'])assert.equal(await f.count(`SELECT count(*)::int AS n FROM ${t} WHERE scenario_id='presenter-r2'`),0,t);
    // The old scenario is kept as it was, and retired.
    for(const t of tables)assert.equal(await f.count(`SELECT count(*)::int AS n FROM ${t} WHERE scenario_id='presenter'`),before[t],`${t} unchanged`);
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM demo_namespaces WHERE scenario_id='presenter' AND retired_at IS NOT NULL`),1);
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM audit_events WHERE scenario_id='presenter' AND event_type='demo.scenario.reset'`),1);
    await chainAudit(f.db);await verifyAuditFull(f.db);
    assert.deepEqual(await assertMarketInvariants(f.db,{lapseGraceSeconds:3600}),[]);
    for(const s of ['presenter','presenter-r2'])assert.deepEqual(await assertPayoutInvariants(f.db,s),[],s);
    // The presenter signs in again and works in the clean scenario.
    const again=await f.session('presenter');
    assert.deepEqual((await f.send('GET','/demo/orders',again)).json().orders,[]);
    assert.equal((await f.send('GET','/market/inventory',await f.session('buyer'))).json().available,200);
  }finally{await f.close();}
});

test('a replayed reset returns the same scenario, a second reset rotates again, and the confirmation is required',async()=>{
  const f=await demoApp();
  try{
    const presenter=await f.session('presenter');
    assert.equal((await reset(f,presenter,{confirm:'reset'})).statusCode,400);
    assert.equal((await f.send('POST','/demo/reset',presenter,{requestId:randomUUID()})).statusCode,400);
    const requestId=randomUUID();
    assert.equal((await reset(f,presenter,{requestId})).json().scenarioId,'presenter-r2');
    const back=await f.session('presenter');
    assert.deepEqual((await reset(f,back,{requestId})).json(),{namespace:'DEMO_ONLY',scenarioId:'presenter-r2',replayed:true,signInAgain:true});
    assert.equal((await reset(f,back)).json().scenarioId,'presenter-r3');
    assert.equal(await scenarioOf(f,'presenter'),'presenter-r3');
  }finally{await f.close();}
});

test('only the presenter may reset, never in the public showcase, and always with CSRF',async()=>{
  const f=await demoApp();
  try{
    for(const who of ['agent-2','verifier','buyer','show-presenter'])assert.equal((await reset(f,await f.session(who))).statusCode,403,who);
    const {'x-csrf-token':_,...noCsrf}=await f.session('presenter');
    assert.equal((await reset(f,noCsrf)).statusCode,403);
    assert.equal(await scenarioOf(f,'presenter'),'presenter');
  }finally{await f.close();}
});

test('after a reset the old scenario is out of sight, its certificates still verify, and nothing new starts there',async()=>{
  const f=await demoApp();
  try{
    const presenter=await f.session('presenter'),buyer=await f.session('buyer');
    const orderId=await f.sell(buyer,presenter,2);
    const number=(await f.send('POST',`/orders/${orderId}/certificate`,buyer)).json().certificate.number;
    await reset(f,presenter);
    const buyerAgain=await f.session('buyer');
    assert.equal((await f.send('GET',`/orders/${orderId}`,buyerAgain)).statusCode,404,'the old order belongs to a retired scenario');
    assert.equal((await f.send('GET',`/certificates/${number}`)).json().intact,true,'issued certificates stay verifiable');
    // An actor still bound to the old scenario (a stale token, a direct call) cannot start new work there.
    const stale={id:'buyer',scenarioId:'presenter',role:'buyer'};
    await assert.rejects(createOrder(f.db,stale,{requestId:randomUUID(),quantity:1}),(e:any)=>e.code==='SCENARIO_RETIRED');
    await assert.rejects(f.db.query(`INSERT INTO demo_payout_batches(id,scenario_id,run_date,run_seq,request_id,as_of_sim,as_of_real,min_payout_paise,payout_limit_paise,config_version,status,created_by)
      VALUES ($1,'presenter',(now() AT TIME ZONE 'Asia/Kolkata')::date,9,$2,now(),now(),1,1,0,'RUNNING','x')`,[randomUUID(),randomUUID()]),/retired/);
    await assert.rejects(f.db.query(`UPDATE demo_namespaces SET retired_at=NULL WHERE scenario_id='presenter'`),/retired/,'a retired scenario is never revived');
    await assert.rejects(requirePresenter(f.db,{id:'presenter',role:'agent',scenarioId:'presenter'},{demoMode:true,presenterIds:['presenter'],publicScenarioId:'showcase'}),
      (e:any)=>e.code==='SCENARIO_RETIRED','a presenter session left in the old scenario cannot drive it');
  }finally{await f.close();}
});

test('money in flight in the old scenario is finished: a late payment fulfils, a sent payout settles, no new runs start',async()=>{
  const f=await demoApp();
  try{
    const presenter=await f.session('presenter'),buyer=await f.session('buyer');
    await f.send('PUT','/demo/ledger-config',presenter,{holdbackDays:0,reserveBps:2000,minPayoutPaise:'10000',payoutLimitPaise:'5000000'});
    await f.sell(buyer,presenter,2);
    assert.ok((await f.send('POST','/demo/payouts/batch',presenter,{requestId:randomUUID()})).json().payouts>=1);
    const rail=new SandboxRail(f.db),state=newPayoutSweepState();
    await payoutSweep(f.db,{rail,state,invariantEverySeconds:3600});
    assert.ok(await f.count(`SELECT count(*)::int AS n FROM demo_payouts WHERE scenario_id='presenter' AND state='SENT'`)>=1);
    const pending=await f.reserve(buyer,2);
    const runsBefore=await f.count(`SELECT count(*)::int AS n FROM demo_payout_batches WHERE scenario_id='presenter'`);
    await reset(f,presenter);
    const config={...DEFAULT_PAYMENTS,secrets:[webhookSecret]};
    const late=await handlePaymentEvent(f.db,signedDelivery(config,eventBody({id:`evt_${randomUUID()}`,type:'payment.succeeded',providerRef:pending.providerRef,amountPaise:PRICE*2n,currency:'INR'})),config);
    assert.equal(late.outcome,'FULFILLED','the provider\'s late success is still applied');
    await payoutSweep(f.db,{rail,state,invariantEverySeconds:3600});
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM demo_payouts WHERE scenario_id='presenter' AND state NOT IN ('SETTLED')`),0,'the worker finished the old scenario\'s payouts');
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM demo_payout_batches WHERE scenario_id='presenter'`),runsBefore,'no new runs in a retired scenario');
    assert.deepEqual(await assertPayoutInvariants(f.db,'presenter'),[]);
  }finally{await f.close();}
});

test('a reset that fails while seeding changes nothing',async()=>{
  const f=await demoApp();
  try{
    await f.session('presenter');
    const actor={id:'presenter',scenarioId:'presenter',role:'agent'};
    await assert.rejects(resetPresenterScenario(f.db,actor,{requestId:randomUUID(),confirm:'RESET'},{seed:async()=>{throw new Error('seed failed');}}),/seed failed/);
    assert.equal(await scenarioOf(f,'presenter'),'presenter');
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM scenarios WHERE id LIKE 'presenter-r%'`),0);
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM demo_namespaces WHERE retired_at IS NOT NULL`),0);
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.id='presenter'`),1,'sessions kept');
  }finally{await f.close();}
});
