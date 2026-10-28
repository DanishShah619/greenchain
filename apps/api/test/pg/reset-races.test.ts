import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,race,testDatabaseUrl} from '../support/pg.js';
import {seedDemoMarket} from '../../src/modules/market/application/seed.js';
import {issueCertificate} from '../../src/modules/market/application/certificates.js';
import {resetPresenterScenario} from '../../src/modules/demo/application/reset.js';
import {sellViaWebhook} from '../support/payouts.js';
// Races of docs/24 on real PostgreSQL: concurrent resets and concurrent certificate issues.
const opts={skip:testDatabaseUrl?false:'TEST_DATABASE_URL is not set (the guard test fails loudly in npm run test:pg)'};
const presenter={id:'presenter',scenarioId:'presenter',role:'agent'};
async function demo(){
  const t=await createTestDatabase();
  await t.db.query(`INSERT INTO scenarios(id) VALUES ('presenter')`);await t.db.query(`INSERT INTO demo_namespaces(scenario_id) VALUES ('presenter')`);
  for(const [id,role] of [['presenter','agent'],['verifier','verifier'],['buyer-1','buyer']])await t.db.query(`INSERT INTO users(id,scenario_id,role,password_hash) VALUES ($1,'presenter',$2,'x')`,[id,role]);
  await seedDemoMarket(t.db,{scenarioId:'presenter'});
  return t;
}

test('concurrent resets: one rotation per scenario; the same request id is replayed, a different one finds the scenario retired',opts,async()=>{
  const t=await demo();
  try{
    const same=randomUUID();
    const results=await race(6,i=>resetPresenterScenario(t.connect(),presenter,{requestId:i<3?same:randomUUID(),confirm:'RESET'}));
    const ok=results.filter(r=>r.status==='fulfilled').map(r=>(r as PromiseFulfilledResult<any>).value);
    const failed=results.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason?.code);
    assert.equal(new Set(ok.map(v=>v.scenarioId)).size,1,'one new scenario');
    assert.equal(ok.filter(v=>!v.replayed).length,1,'one rotation');
    assert.ok(failed.every(c=>c==='SCENARIO_RETIRED'),JSON.stringify(failed));
    assert.equal(ok.length+failed.length,6);
    // Repeats of one request get one answer: all succeed (the rotation and its replays), or all are refused because a different
    // request rotated the scenario first. Never a mix.
    assert.equal(new Set(results.slice(0,3).map(r=>r.status)).size,1,`same-request answers: ${results.slice(0,3).map(r=>r.status)}`);
    assert.equal((await t.db.query(`SELECT count(*)::int AS n FROM scenarios WHERE id LIKE 'presenter-r%'`)).rows[0].n,1);
    assert.deepEqual((await t.db.query(`SELECT id FROM users WHERE scenario_id='presenter-r2' ORDER BY id`)).rows.map(r=>r.id),
      ['buyer-1','presenter','presenter-r2-market-reviewer','verifier'],'the three accounts moved once, plus the new seed reviewer');
  }finally{await t.close();}
});

test('concurrent first requests for a certificate issue exactly one, with one number',opts,async()=>{
  const t=await demo();
  try{
    const orderId=await sellViaWebhook(t.db,{buyerId:'buyer-1',quantity:2,scenario:'presenter'});
    const buyer={id:'buyer-1',scenarioId:'presenter',role:'buyer'};
    const results=await race(8,()=>issueCertificate(t.connect(),buyer,orderId));
    const values=results.map(r=>{assert.equal(r.status,'fulfilled',String((r as PromiseRejectedResult).reason));return (r as PromiseFulfilledResult<any>).value;});
    assert.equal(new Set(values.map(v=>v.certificate.number)).size,1);
    assert.equal(values.filter(v=>!v.replayed).length,1);
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM demo_certificates')).rows[0].n,1);
    assert.equal((await t.db.query(`SELECT count(*)::int AS n FROM audit_events WHERE event_type='market.certificate.issued'`)).rows[0].n,1);
  }finally{await t.close();}
});
