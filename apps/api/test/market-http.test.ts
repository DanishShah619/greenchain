import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../src/bootstrap/app.js';
import {marketConfig} from '../src/bootstrap/config.js';
import {migratedPglite} from './support/pglite.js';
import {hashPassword} from '../src/kernel/password.js';
import {seedDemoMarket,DEMO_PRICE_PAISE,SHOWCASE_MARKET} from '../src/modules/market/application/seed.js';
import {DEFAULT_MARKET} from '../src/modules/market/application/orders.js';
import {DEFAULT_PAYMENTS} from '../src/modules/market/application/payments.js';
import {WEBHOOK_PATH} from '../src/modules/market/http/routes.js';
import {eventBody,signedDelivery} from '../src/modules/market/infrastructure/simulator.js';
import {assertMarketInvariants} from '../src/modules/market/application/invariants.js';
const origin='http://localhost:3000',password='test-password-for-demo-123',secret='test-webhook-secret-of-at-least-32-chars';
type Headers=Record<string,string>;
async function fixture(o:{demoMode?:boolean;secrets?:string[]}={}){
  const {pg,db}=await migratedPglite();
  await db.query("INSERT INTO scenarios(id) VALUES ('presenter'),('other')");
  await db.query("INSERT INTO demo_namespaces(scenario_id) VALUES ('presenter'),('other')");
  for(const [id,scenario,role] of [['presenter','presenter','agent'],['verifier','presenter','verifier'],['buyer','presenter','buyer'],['buyer-2','presenter','buyer'],['buyer-other','other','buyer']])
    await db.query('INSERT INTO users(id,scenario_id,role,password_hash) VALUES ($1,$2,$3,$4)',[id,scenario,role,hashPassword(password)]);
  await seedDemoMarket(db,{scenarioId:'presenter'});
  const config={market:DEFAULT_MARKET,payments:{...DEFAULT_PAYMENTS,secrets:o.secrets??[secret]},demoMode:o.demoMode??true};
  const app=await buildApp(db,{origin,secure:false,market:config});
  async function login(account:'presenter'|'verifier'|'buyer'):Promise<Headers>{
    const r=await app.inject({method:'POST',url:'/api/v1/session',headers:{origin},payload:{password,account}});assert.equal(r.statusCode,200,r.body);
    return {origin,cookie:`session=${r.cookies[0].value}`,'x-csrf-token':r.json().csrf};
  }
  /** Accounts the login form does not offer get a session row directly. */
  async function session(userId:string):Promise<Headers>{
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
    await db.query(`INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`,[createHash('sha256').update(token).digest('hex'),userId,csrf]);
    return {origin,cookie:`session=${token}`,'x-csrf-token':csrf};
  }
  const send=(method:'GET'|'POST'|'PUT',url:string,headers:Headers,payload?:unknown)=>app.inject({method,url,headers,...(payload===undefined?{}:{payload:payload as any})});
  return {db,app,login,session,send,config,close:async()=>{await app.close();await pg.close();}};
}
test('a buyer browses, orders, pays through the simulator and owns the credits; replaying the callback changes nothing',async()=>{
  const f=await fixture();
  try{
    const buyer=await f.login('buyer'),presenter=await f.login('presenter');
    const inv=(await f.send('GET','/api/v1/market/inventory',buyer)).json();
    assert.equal(inv.available,200);assert.equal(inv.unitPricePaise,String(DEMO_PRICE_PAISE));assert.equal(inv.groups.length,20);
    assert.match(inv.label,/Demonstration/);assert.doesNotMatch(JSON.stringify(inv),/Market seed farmer|Synthetic village/,'no farmer data');
    const requestId=randomUUID(),body={requestId,quantity:20,quotedTotalPaise:String(DEMO_PRICE_PAISE*20n)};
    const created=await f.send('POST','/api/v1/orders',buyer,body);assert.equal(created.statusCode,201,created.body);
    const order=created.json();assert.equal(order.order.state,'RESERVED');assert.equal(order.priceChangedFromQuote,false);
    assert.equal((await f.send('POST','/api/v1/orders',buyer,body)).statusCode,200,'replay');
    const pay=await f.send('POST',`/api/v1/orders/${order.order.id}/payment-attempts`,buyer,{acceptSnapshotHash:order.snapshotHash});assert.equal(pay.statusCode,200,pay.body);
    assert.equal((await f.send('POST',`/api/v1/demo/orders/${order.order.id}/simulate`,presenter,{outcome:'pending'})).json().outcome,'ATTEMPT_UPDATED');
    assert.equal((await f.send('POST',`/api/v1/demo/orders/${order.order.id}/simulate`,presenter,{outcome:'success'})).json().outcome,'FULFILLED');
    const ledgerBefore=(await f.db.query('SELECT count(*)::int AS n FROM demo_ledger_entries')).rows[0].n;
    const replay=(await f.send('POST',`/api/v1/demo/orders/${order.order.id}/simulate`,presenter,{outcome:'replay'})).json();
    assert.equal(replay.outcome,'FULFILLED');assert.equal(replay.replayed,true);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_ledger_entries')).rows[0].n,ledgerBefore,'the ledger is unchanged by the replay');
    const done=(await f.send('GET',`/api/v1/orders/${order.order.id}`,buyer)).json();
    assert.equal(done.order.state,'FULFILLED');assert.equal(done.purchased.length,20);
    assert.equal((await f.send('GET','/api/v1/orders',buyer)).json().orders[0].state,'FULFILLED');
    // The presenter sees the scenario's orders (to drive the simulator from a second window), without farmer data.
    const listed=(await f.send('GET','/api/v1/demo/orders',presenter)).json();
    assert.equal(listed.orders[0].id,order.order.id);assert.equal(listed.orders[0].payment,'SUCCEEDED');assert.ok(listed.outcomes.includes('late_success'));
    assert.doesNotMatch(JSON.stringify(listed),/Market seed farmer|Synthetic village/);
    assert.equal((await f.send('GET','/api/v1/demo/orders',buyer)).statusCode,403);
    assert.deepEqual(await assertMarketInvariants(f.db),[]);
    // The invariant report for the presenter (and the market smoke script): codes and counts only.
    assert.deepEqual((await f.send('GET','/api/v1/demo/invariants',presenter)).json().violations,[]);
    assert.equal((await f.send('GET','/api/v1/demo/invariants',buyer)).statusCode,403);
    await f.db.query(`INSERT INTO demo_payment_events(provider,provider_event_id,attempt_id,scenario_id,type,payload_hash,amount_paise,outcome)
      SELECT 'simulator','evt_stranded',id,scenario_id,'payment.succeeded','h',5,'AMOUNT_MISMATCH' FROM demo_payment_attempts LIMIT 1`);
    assert.deepEqual((await f.send('GET','/api/v1/demo/invariants',presenter)).json().violations,[{code:'CAPTURE_NOT_ACCOUNTED',count:1}]);
  }finally{await f.close();}
});
test('role matrix: buyer routes are buyer-only, and a buyer is refused on agent and verifier routes',async()=>{
  const f=await fixture();
  try{
    const buyer=await f.login('buyer'),presenter=await f.login('presenter'),verifier=await f.login('verifier'),anonymous={origin};
    for(const who of [presenter,verifier]){
      assert.equal((await f.send('GET','/api/v1/market/inventory',who)).statusCode,403);
      assert.equal((await f.send('POST','/api/v1/orders',who,{requestId:randomUUID(),quantity:1})).statusCode,403);
      assert.equal((await f.send('GET','/api/v1/orders',who)).statusCode,403);
    }
    assert.equal((await f.send('GET','/api/v1/market/inventory',anonymous)).statusCode,401);
    assert.equal((await f.send('GET','/api/v1/captures',buyer)).statusCode,403);
    assert.equal((await f.send('GET','/api/v1/verification/cases',buyer)).statusCode,403);
    const someCase=(await f.db.query(`SELECT event_id FROM captures LIMIT 1`)).rows[0].event_id;
    // A case lookup refuses a buyer either way: 404 when the case has no review record, 403 when it does. Never 200.
    assert.ok([403,404].includes((await f.send('GET',`/api/v1/cases/${someCase}`,buyer)).statusCode));
    assert.equal((await f.send('POST','/api/v1/captures',buyer,{eventId:randomUUID(),farmerLabel:'x',village:'y',areaHectares:'1.00',consent:true})).statusCode,403);
    const order=(await f.send('POST','/api/v1/orders',buyer,{requestId:randomUUID(),quantity:1})).json();
    assert.equal((await f.send('POST',`/api/v1/demo/orders/${order.order.id}/simulate`,buyer,{outcome:'success'})).statusCode,403,'buyers cannot fake payments');
  }finally{await f.close();}
});
test('orders are invisible across buyers and scenarios (404, never 403)',async()=>{
  const f=await fixture();
  try{
    const buyer=await f.login('buyer'),other=await f.session('buyer-2'),elsewhere=await f.session('buyer-other');
    const order=(await f.send('POST','/api/v1/orders',buyer,{requestId:randomUUID(),quantity:1})).json();
    for(const who of [other,elsewhere]){
      assert.equal((await f.send('GET',`/api/v1/orders/${order.order.id}`,who)).statusCode,404);
      assert.equal((await f.send('POST',`/api/v1/orders/${order.order.id}/cancel`,who)).statusCode,404);
      assert.equal((await f.send('POST',`/api/v1/orders/${order.order.id}/payment-attempts`,who,{acceptSnapshotHash:order.snapshotHash})).statusCode,404);
      assert.equal((await f.send('GET','/api/v1/orders',who)).json().orders.length,0);
    }
    assert.equal((await f.send('GET',`/api/v1/orders/not-a-uuid`,buyer)).statusCode,400);
    const otherScenarioInventory=(await f.send('GET','/api/v1/market/inventory',elsewhere)).json();
    assert.equal(otherScenarioInventory.available,0,'a buyer sees only their own scenario');
  }finally{await f.close();}
});
test('buyer writes need the session CSRF token and the trusted origin; bodies are validated',async()=>{
  const f=await fixture();
  try{
    const buyer=await f.login('buyer');
    assert.equal((await f.send('POST','/api/v1/orders',{...buyer,'x-csrf-token':'wrong'},{requestId:randomUUID(),quantity:1})).statusCode,403);
    assert.equal((await f.send('POST','/api/v1/orders',{...buyer,origin:'https://evil.example'},{requestId:randomUUID(),quantity:1})).statusCode,403);
    for(const payload of [{requestId:randomUUID(),quantity:0},{requestId:randomUUID(),quantity:2.5},{requestId:'x',quantity:1},{requestId:randomUUID(),quantity:1,price:1},{requestId:randomUUID(),quantity:1,quotedTotalPaise:'1.5'}])
      assert.equal((await f.send('POST','/api/v1/orders',buyer,payload)).statusCode,400,JSON.stringify(payload));
    assert.equal((await f.send('POST','/api/v1/orders',buyer,{requestId:randomUUID(),quantity:21})).json().code,'BUYER_LIMIT');
  }finally{await f.close();}
});
test('the webhook needs no cookie or origin but a valid signature, and is rate limited',async()=>{
  const f=await fixture();
  try{
    const buyer=await f.login('buyer');
    const order=(await f.send('POST','/api/v1/orders',buyer,{requestId:randomUUID(),quantity:1})).json();
    const pay=(await f.send('POST',`/api/v1/orders/${order.order.id}/payment-attempts`,buyer,{acceptSnapshotHash:order.snapshotHash})).json();
    const d=signedDelivery(f.config.payments,eventBody({id:'evt_http',type:'payment.succeeded',providerRef:pay.providerRef,amountPaise:DEMO_PRICE_PAISE,currency:'INR'}));
    const post=(headers:Record<string,string>,body:Buffer=d.body)=>f.app.inject({method:'POST',url:WEBHOOK_PATH,headers:{'content-type':'application/json',...headers},payload:body});
    assert.equal((await post({'x-greenchain-timestamp':d.timestamp,'x-greenchain-signature':'0'.repeat(64)})).statusCode,401);
    assert.equal((await post({'x-greenchain-timestamp':d.timestamp})).statusCode,401);
    const ok=await post({'x-greenchain-timestamp':d.timestamp,'x-greenchain-signature':d.signature});
    assert.equal(ok.statusCode,200,ok.body);assert.equal(ok.json().outcome,'FULFILLED');
    const again=await post({'x-greenchain-timestamp':d.timestamp,'x-greenchain-signature':d.signature});
    assert.deepEqual(again.json(),{received:true,outcome:'FULFILLED',replayed:true});
    // A browser posting cross-site gets no further: there is no session involvement and the signature still decides.
    assert.equal((await post({origin:'https://evil.example','x-greenchain-timestamp':d.timestamp,'x-greenchain-signature':'1'.repeat(64)})).statusCode,401);
    assert.equal((await f.app.inject({method:'POST',url:WEBHOOK_PATH,headers:{'content-type':'application/json'},payload:Buffer.alloc(17000,32)})).statusCode,413);
  }finally{await f.close();}
  // Rate limit: a low limit so the test is quick.
  const g=await fixture();
  try{
    const app=await buildApp(g.db,{origin,secure:false,market:{...g.config,webhookRatePerMinute:3}});
    const codes=[];for(let i=0;i<5;i++)codes.push((await app.inject({method:'POST',url:WEBHOOK_PATH,headers:{'content-type':'application/json'},payload:'{}'})).statusCode);
    assert.deepEqual(codes,[401,401,401,429,429]);await app.close();
  }finally{await g.close();}
});
test('without a webhook secret neither the webhook nor the simulator exists; without demo mode the simulator does not',async()=>{
  const none=await fixture({secrets:[]});
  try{
    const presenter=await none.login('presenter');
    assert.equal((await none.app.inject({method:'POST',url:WEBHOOK_PATH,headers:{'content-type':'application/json'},payload:'{}'})).statusCode,404);
    assert.equal((await none.send('POST',`/api/v1/demo/orders/${randomUUID()}/simulate`,presenter,{outcome:'success'})).statusCode,404);
  }finally{await none.close();}
  const live=await fixture({demoMode:false});
  try{
    const presenter=await live.login('presenter');
    assert.equal((await live.send('POST',`/api/v1/demo/orders/${randomUUID()}/simulate`,presenter,{outcome:'success'})).statusCode,404);
    assert.equal((await live.send('GET','/api/v1/demo/orders',presenter)).statusCode,404);
    assert.equal((await live.send('GET','/api/v1/demo/invariants',presenter)).statusCode,404);
  }finally{await live.close();}
});
test('market configuration from the environment is validated',()=>{
  assert.deepEqual(marketConfig({}).payments.secrets,[]);assert.equal(marketConfig({}).demoMode,false);
  assert.throws(()=>marketConfig({PAYMENT_WEBHOOK_SECRET:'short'}));
  assert.throws(()=>marketConfig({PAYMENT_WEBHOOK_SECRET_PREVIOUS:'x'.repeat(40)}));
  assert.throws(()=>marketConfig({DEMO_MODE:'yes'}));assert.throws(()=>marketConfig({DEMO_COMMISSION_BPS:'12.5'}));
  const c=marketConfig({PAYMENT_WEBHOOK_SECRET:'a'.repeat(40),PAYMENT_WEBHOOK_SECRET_PREVIOUS:'b'.repeat(40),DEMO_MODE:'true',DEMO_COMMISSION_BPS:'250'});
  assert.deepEqual(c.payments.secrets,['a'.repeat(40),'b'.repeat(40)]);assert.equal(c.demoMode,true);assert.equal(c.market.commissionBps,250);
});
test('the demo market seed is idempotent and leaves sold credits alone',async()=>{
  const {db}=await migratedPglite();
  await db.query("INSERT INTO scenarios(id) VALUES ('presenter')");await db.query("INSERT INTO demo_namespaces(scenario_id) VALUES ('presenter')");
  assert.deepEqual(await seedDemoMarket(db,{scenarioId:'presenter'}),{groupsCreated:20});
  await db.query(`UPDATE demo_credits SET state='REVERSED' WHERE ordinal=1`);
  assert.deepEqual(await seedDemoMarket(db,{scenarioId:'presenter'}),{groupsCreated:0});
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM demo_credits`)).rows[0].n,200);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM demo_credits WHERE state='REVERSED'`)).rows[0].n,20,'existing state preserved');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM demo_price_list`)).rows[0].n,1);
});
test('the public showcase shows read-only sample market counts and hides the seed\'s synthetic cases',async()=>{
  const f=await fixture();
  try{
    await f.db.query("INSERT INTO scenarios(id) VALUES ('showcase')");await f.db.query("INSERT INTO demo_namespaces(scenario_id) VALUES ('showcase')");
    await f.db.query(`INSERT INTO captures(scenario_id,event_id,actor_id,fingerprint,farmer_label,village,area_hectares) VALUES ('showcase',$1,'seed','fixture','Demo farmer 01','Nadia',1.25)`,[randomUUID()]);
    assert.deepEqual(await seedDemoMarket(f.db,SHOWCASE_MARKET),{groupsCreated:6});
    const r=await f.app.inject({url:'/api/v1/showcase'});assert.equal(r.statusCode,200);
    const body=r.json();
    assert.deepEqual(body.captures.map((c:any)=>c.farmer_label),['Demo farmer 01'],'the market seed\'s cases are not showcase captures');
    assert.deepEqual(body.market,{namespace:'DEMO_ONLY',label:'Demonstration — synthetic credits and simulated payments',currency:'INR',
      unitPricePaise:String(DEMO_PRICE_PAISE),groups:6,available:30,reserved:0,sold:0});
    assert.doesNotMatch(JSON.stringify(body.market),/Group |batch|DEMO-2026|Market seed/,'totals only: no groups, ids or provenance');
    // The presenter's market is a different scenario and is not counted.
    assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM demo_credits c JOIN demo_issuance_batches b ON b.id=c.batch_id WHERE b.scenario_id='presenter'`)).rows[0].n,200);
  }finally{await f.close();}
});
test('CORS preflight allows every method the web app uses (sign-out is DELETE, boundary and chunk uploads are PUT)',async()=>{
  const f=await fixture();
  try{
    for(const [method,url] of [['DELETE','/api/v1/session'],['PUT','/api/v1/uploads/x/chunks/0'],['POST','/api/v1/orders']] as const){
      const r=await f.app.inject({method:'OPTIONS',url,headers:{origin,'access-control-request-method':method,'access-control-request-headers':'content-type,x-csrf-token'}});
      assert.equal(r.statusCode,204);
      assert.ok(String(r.headers['access-control-allow-methods']).split(/,\s*/).includes(method),`${method} ${url}: ${r.headers['access-control-allow-methods']}`);
      assert.equal(r.headers['access-control-allow-origin'],origin);
    }
    const other=await f.app.inject({method:'OPTIONS',url:'/api/v1/session',headers:{origin:'https://evil.example','access-control-request-method':'DELETE'}});
    assert.notEqual(other.headers['access-control-allow-origin'],'https://evil.example','other origins are still refused');
  }finally{await f.close();}
});
