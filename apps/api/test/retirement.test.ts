import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertMarketInvariants,INVARIANT_CODES} from '../src/modules/market/application/invariants.js';
import {retireCredits} from '../src/modules/market/application/retirements.js';
import {assertPayoutInvariants} from '../src/modules/payouts/application/invariants.js';
import {certificateHash,RETIREMENT_NUMBER} from '../src/modules/market/domain/certificate.js';
import {demoApp} from './support/demo-app.js';
// Credit retirement and the retirement certificate (docs/25 T1-T8).
async function setup(){
  const f=await demoApp();
  const buyer=await f.session('buyer'),presenter=await f.session('presenter');
  return {...f,buyer,presenter};
}
const retire=(f:Awaited<ReturnType<typeof setup>>,orderId:string,body:Record<string,unknown>,who=f.buyer)=>
  f.send('POST',`/orders/${orderId}/retirements`,who,{requestId:randomUUID(),reportingPeriod:'FY2026-27',...body});
const states=async(f:{db:any},orderId:string)=>(await f.db.query(`SELECT c.state,count(*)::int AS n FROM demo_credits c JOIN demo_ledger_entries e ON e.credit_id=c.id WHERE e.order_id=$1 GROUP BY 1 ORDER BY 1`,[orderId])).rows;

test('a buyer retires some credits of a paid order for a reporting period and receives a frozen retirement certificate',async()=>{
  const f=await setup();
  try{
    const orderId=await f.sell(f.buyer,f.presenter,3);
    const purchase=(await f.send('POST',`/orders/${orderId}/certificate`,f.buyer)).json().certificate.number;
    const ledgerBefore=await f.count('SELECT count(*)::int AS n FROM demo_journal_lines');
    const requestId=randomUUID();
    const r=await retire(f,orderId,{requestId,count:2,purpose:'Scope 3 offset, FY2026-27 report'});
    assert.equal(r.statusCode,201,r.body);
    const {retirement,certificate,replayed}=r.json();
    assert.equal(replayed,false);assert.equal(retirement.creditCount,2);assert.equal(retirement.reportingPeriod,'FY2026-27');
    assert.match(certificate.number,RETIREMENT_NUMBER);assert.equal(certificate.contentSha256,certificateHash(certificate.content));
    const c=certificate.content;
    assert.equal(c.kind,'RETIREMENT');assert.equal(c.reportingPeriod,'FY2026-27');assert.equal(c.purpose,'Scope 3 offset, FY2026-27 report');
    assert.equal(c.credits.length,2);assert.deepEqual(c.credits.map((x:any)=>x.id),[...retirement.creditIds].sort(),'the oldest credit ids of the order');
    assert.deepEqual(c.purchaseCertificates,[purchase]);assert.deepEqual(c.buyer,{account:'buyer'});
    assert.deepEqual(await states(f,orderId),[{state:'RETIRED',n:2},{state:'SOLD',n:1}]);
    const again=await f.send('POST',`/orders/${orderId}/retirements`,f.buyer,{requestId,count:2,reportingPeriod:'FY2026-27',purpose:'Scope 3 offset, FY2026-27 report'});
    assert.equal(again.statusCode,200);assert.equal(again.json().replayed,true);assert.equal(again.json().certificate.number,certificate.number);
    assert.equal((await f.send('POST',`/orders/${orderId}/retirements`,f.buyer,{requestId,count:1,reportingPeriod:'FY2026-27'})).json().code,'KEY_REUSE','same request id, different body');
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM audit_events WHERE event_type='market.credits.retired'`),1);
    assert.equal(await f.count('SELECT count(*)::int AS n FROM demo_journal_lines'),ledgerBefore,'retiring moves no money');
    assert.deepEqual(await assertMarketInvariants(f.db,{lapseGraceSeconds:3600}),[]);assert.deepEqual(await assertPayoutInvariants(f.db,'presenter'),[]);
    const view=(await f.send('GET',`/orders/${orderId}`,f.buyer)).json();
    assert.equal(view.purchased.filter((p:any)=>p.retired).length,2,'the order shows which credits are retired');
    const list=(await f.send('GET','/retirements',f.buyer)).json();
    assert.deepEqual(list.retirements.map((x:any)=>[x.creditCount,x.certificateNumber]),[[2,certificate.number]]);
    assert.deepEqual(list.totals,{purchased:3,retired:2,held:1});
    assert.deepEqual((await f.send('GET',`/retirements/${retirement.id}/certificate`,f.buyer)).json().certificate,certificate);
    const inventory=(await f.send('GET','/market/inventory',f.buyer)).json();
    assert.equal(inventory.groups.reduce((n:number,g:any)=>n+g.sold,0),3,'retired credits still count as sold, not as available');
    const other=await f.session('buyer-2');
    assert.deepEqual((await f.send('GET','/retirements',other)).json().retirements,[]);
    assert.equal((await f.send('GET',`/retirements/${retirement.id}/certificate`,other)).statusCode,404,'another buyer cannot read it');
  }finally{await f.close();}
});

test('explicit credit ids can span the buyer\'s paid orders; retired credits cannot be retired again',async()=>{
  const f=await setup();
  try{
    const a=await f.sell(f.buyer,f.presenter,2),b=await f.sell(f.buyer,f.presenter,2);
    const ids=[...(await f.db.query('SELECT credit_id FROM demo_ledger_entries WHERE order_id=$1 ORDER BY credit_id LIMIT 1',[a])).rows,
      ...(await f.db.query('SELECT credit_id FROM demo_ledger_entries WHERE order_id=$1 ORDER BY credit_id LIMIT 1',[b])).rows].map((r:any)=>r.credit_id);
    const r=await f.send('POST','/retirements',f.buyer,{requestId:randomUUID(),creditIds:ids,reportingPeriod:'2026'});
    assert.equal(r.statusCode,201,r.body);assert.equal(r.json().certificate.content.credits.length,2);
    assert.equal((await f.send('POST','/retirements',f.buyer,{requestId:randomUUID(),creditIds:[ids[0]],reportingPeriod:'2026'})).json().code,'CREDIT_NOT_RETIRABLE');
    assert.equal((await retire(f,a,{count:2})).json().code,'NOT_ENOUGH_CREDITS','only one SOLD credit left in order a');
    assert.deepEqual(await states(f,a),[{state:'RETIRED',n:1},{state:'SOLD',n:1}],'a refused request retires nothing');
  }finally{await f.close();}
});

test('only the owning buyer retires, only paid credits, with a valid period and a safe public purpose',async()=>{
  const f=await setup();
  try{
    const orderId=await f.sell(f.buyer,f.presenter,2);
    const {orderId:unpaid}=await f.reserve(f.buyer,2);
    assert.equal((await retire(f,orderId,{count:1},await f.session('buyer-2'))).statusCode,404,'another buyer');
    for(const who of ['verifier','presenter','agent-2'])assert.equal((await retire(f,orderId,{count:1},await f.session(who))).statusCode,403,who);
    assert.equal((await retire(f,unpaid,{count:1})).json().code,'ORDER_NOT_FULFILLED');
    const foreign=(await f.db.query(`SELECT id FROM demo_credits WHERE state='AVAILABLE' LIMIT 1`)).rows[0].id;
    assert.equal((await f.send('POST','/retirements',f.buyer,{requestId:randomUUID(),creditIds:[foreign],reportingPeriod:'2026'})).statusCode,404,'credits the buyer does not own');
    const theirs=await f.sell(await f.session('buyer-2'),f.presenter,1);
    const theirCredit=(await f.db.query('SELECT credit_id FROM demo_ledger_entries WHERE order_id=$1',[theirs])).rows[0].credit_id;
    assert.equal((await f.send('POST','/retirements',f.buyer,{requestId:randomUUID(),creditIds:[theirCredit],reportingPeriod:'2026'})).statusCode,404,'credits another buyer bought');
    for(const bad of [{reportingPeriod:'FY2026-28'},{reportingPeriod:'2026-27'},{reportingPeriod:'1999'},{purpose:'<script>x</script>'},{purpose:'x'.repeat(121)},{count:0},{count:101}])
      assert.equal((await retire(f,orderId,{count:1,...bad})).statusCode,400,JSON.stringify(bad));
    const {'x-csrf-token':_,...noCsrf}=f.buyer;
    assert.equal((await retire(f,orderId,{count:1},noCsrf)).statusCode,403);
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM demo_credits WHERE state='RETIRED'`),0);
  }finally{await f.close();}
});

test('anyone can verify a retirement certificate; a purchase certificate reports how many of its credits were retired since',async()=>{
  const f=await setup();
  try{
    const orderId=await f.sell(f.buyer,f.presenter,3);
    const purchase=(await f.send('POST',`/orders/${orderId}/certificate`,f.buyer)).json().certificate.number;
    const retirement=(await retire(f,orderId,{count:2,purpose:'Annual report'})).json().certificate;
    const pub=(await f.send('GET',`/certificates/${retirement.number}?hash=${retirement.contentSha256}`)).json();
    assert.equal(pub.intact,true);assert.equal(pub.hashMatches,true);assert.deepEqual(pub.content.buyer,{account:'Demo buyer'});assert.equal(pub.content.kind,'RETIREMENT');
    assert.deepEqual((await f.send('GET',`/certificates/${purchase}`)).json().retired,{credits:2,of:3});
    await f.db.query('SET session_replication_role = replica');
    await f.db.query(`UPDATE demo_retirement_certificates SET content=jsonb_set(content,'{reportingPeriod}','"2030"') WHERE number=$1`,[retirement.number]);
    await f.db.query('SET session_replication_role = origin');
    const altered=(await f.send('GET',`/certificates/${retirement.number}?hash=${retirement.contentSha256}`)).json();
    assert.equal(altered.intact,false);assert.equal(altered.hashMatches,false);
  }finally{await f.close();}
});

test('the database refuses a retirement without a record, keeps records immutable, and RETIRED is final',async()=>{
  const f=await setup();
  try{
    const orderId=await f.sell(f.buyer,f.presenter,2);
    const credit=(await f.db.query('SELECT credit_id FROM demo_ledger_entries WHERE order_id=$1 LIMIT 1',[orderId])).rows[0].credit_id;
    await assert.rejects(f.db.query(`UPDATE demo_credits SET state='RETIRED' WHERE id=$1`,[credit]),/retire/);
    await retire(f,orderId,{count:1});
    await assert.rejects(f.db.query('UPDATE demo_retirements SET purpose=NULL'));await assert.rejects(f.db.query('DELETE FROM demo_retirement_items'));
    await assert.rejects(f.db.query('UPDATE demo_retirement_certificates SET content_sha256=$1',['0'.repeat(64)]));
    const retired=(await f.db.query(`SELECT id FROM demo_credits WHERE state='RETIRED' LIMIT 1`)).rows[0].id;
    for(const next of ['SOLD','AVAILABLE','RESERVED'])await assert.rejects(f.db.query('UPDATE demo_credits SET state=$2 WHERE id=$1',[retired,next]),next);
    const sold=(await f.db.query(`SELECT id FROM demo_credits WHERE state='SOLD' LIMIT 1`)).rows[0].id,available=(await f.db.query(`SELECT id FROM demo_credits WHERE state='AVAILABLE' LIMIT 1`)).rows[0].id;
    const record=(count:number,creditId:string,owner='buyer')=>f.db.transaction(async tx=>{
      const id=randomUUID();
      await tx.query(`INSERT INTO demo_retirements(id,scenario_id,buyer_id,request_id,request_hash,reporting_period,credit_count) VALUES ($1,'presenter',$3,$1,'x','2026',$2)`,[id,count,owner]);
      await tx.query(`INSERT INTO demo_retirement_items(retirement_id,scenario_id,credit_id) VALUES ($1,'presenter',$2)`,[id,creditId]);
    });
    await assert.rejects(record(1,available),/not a SOLD credit/,'an unsold credit');
    await assert.rejects(record(1,sold,'buyer-2'),/not a SOLD credit/,'a credit another buyer bought');
    await assert.rejects(record(2,sold),/declares 2 credits but has 1/,'the declared count');
  }finally{await f.close();}
});

test('the retirement invariant catches a retired credit without its record, and retiring is refused in a retired scenario',async()=>{
  const f=await setup();
  try{
    assert.ok(INVARIANT_CODES.includes('RETIRED_WITHOUT_RECORD' as any));
    const orderId=await f.sell(f.buyer,f.presenter,2);
    const credit=(await f.db.query('SELECT credit_id FROM demo_ledger_entries WHERE order_id=$1 LIMIT 1',[orderId])).rows[0].credit_id;
    await f.db.query('SET session_replication_role = replica');
    await f.db.query(`UPDATE demo_credits SET state='RETIRED' WHERE id=$1`,[credit]);
    await f.db.query('SET session_replication_role = origin');
    assert.deepEqual((await assertMarketInvariants(f.db,{lapseGraceSeconds:3600})).map(v=>v.code),['RETIRED_WITHOUT_RECORD']);
    await f.send('POST','/demo/reset',f.presenter,{requestId:randomUUID(),confirm:'RESET'});
    await assert.rejects(retireCredits(f.db,{id:'buyer',scenarioId:'presenter',role:'buyer'},{requestId:randomUUID(),orderId,count:1,reportingPeriod:'2026'}),(e:any)=>e.code==='SCENARIO_RETIRED');
    await assert.rejects(f.db.query(`INSERT INTO demo_retirements(id,scenario_id,buyer_id,request_id,request_hash,reporting_period,credit_count) VALUES ($1,'presenter','buyer',$1,'x','2026',1)`,[randomUUID()]),/retired/,'the database refuses it too');
    // Every credit of the order RETIRED without a record, one detached from its order, and the order marked refunded: each
    // extended check must now fire through a RETIRED credit alone.
    await f.db.query('SET session_replication_role = replica');
    await f.db.query(`UPDATE demo_credits SET state='RETIRED' WHERE reserved_order_id=$1`,[orderId]);
    await f.db.query(`UPDATE demo_credits SET reserved_order_id=NULL WHERE id=$1`,[credit]);
    await f.db.query(`UPDATE demo_orders SET state='REFUNDED' WHERE id=$1`,[orderId]);
    await f.db.query('SET session_replication_role = origin');
    const codes=(await assertMarketInvariants(f.db,{lapseGraceSeconds:3600})).map(v=>v.code);
    for(const code of ['SOLD_WITHOUT_FULFILMENT','REFUND_WITH_SALE','RETIRED_WITHOUT_RECORD'])assert.ok(codes.includes(code),`${code} in ${codes}`);
  }finally{await f.close();}
});
