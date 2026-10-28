import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,race,testDatabaseUrl} from '../support/pg.js';
import {seedDemoMarket} from '../../src/modules/market/application/seed.js';
import {retireCredits} from '../../src/modules/market/application/retirements.js';
import {sellViaWebhook} from '../support/payouts.js';
// Retirement races on real PostgreSQL (docs/25 §2).
const opts={skip:testDatabaseUrl?false:'TEST_DATABASE_URL is not set (the guard test fails loudly in npm run test:pg)'};
const buyer={id:'buyer-1',scenarioId:'presenter',role:'buyer'};
async function sold(){
  const t=await createTestDatabase();
  await t.db.query(`INSERT INTO scenarios(id) VALUES ('presenter')`);await t.db.query(`INSERT INTO demo_namespaces(scenario_id) VALUES ('presenter')`);
  await t.db.query(`INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('buyer-1','presenter','buyer','x')`);
  await seedDemoMarket(t.db,{scenarioId:'presenter'});
  const orderId=await sellViaWebhook(t.db,{buyerId:'buyer-1',quantity:4,scenario:'presenter'});
  return {t,orderId};
}
const retired=async(t:any)=>(await t.db.query(`SELECT count(*)::int AS n FROM demo_credits WHERE state='RETIRED'`)).rows[0].n as number;

test('the same retirement request sent concurrently creates one retirement and one certificate',opts,async()=>{
  const {t,orderId}=await sold();
  try{
    const requestId=randomUUID();
    const results=await race(6,()=>retireCredits(t.connect(),buyer,{requestId,orderId,count:2,reportingPeriod:'2026'}));
    const values=results.map(r=>{assert.equal(r.status,'fulfilled',String((r as PromiseRejectedResult).reason));return (r as PromiseFulfilledResult<any>).value;});
    assert.equal(new Set(values.map(v=>v.certificate.number)).size,1);assert.equal(values.filter(v=>!v.replayed).length,1);
    assert.equal(await retired(t),2);
  }finally{await t.close();}
});

test('different requests racing for the same credits: each credit is retired once, losers retire nothing',opts,async()=>{
  const {t,orderId}=await sold();
  try{
    const results=await race(6,()=>retireCredits(t.connect(),buyer,{requestId:randomUUID(),orderId,count:3,reportingPeriod:'2026'}));
    const won=results.filter(r=>r.status==='fulfilled'),lost=results.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason?.code);
    assert.equal(won.length,1,'only one request finds three SOLD credits');
    assert.ok(lost.every(c=>c==='NOT_ENOUGH_CREDITS'||c==='CREDIT_NOT_RETIRABLE'),JSON.stringify(lost));
    assert.equal(await retired(t),3);
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM demo_retirement_items')).rows[0].n,3);
  }finally{await t.close();}
});
