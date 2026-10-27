import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {createLogger} from '../src/kernel/logger.js';
import {Metrics} from '../src/kernel/metrics.js';
import {declareWorkerMetrics,newHealthState,workerCycle} from '../src/modules/ops/application/iteration.js';
import {newPayoutSweepState} from '../src/modules/payouts/application/sweep.js';
import {SandboxRail} from '../src/modules/payouts/infrastructure/sandbox-rail.js';
import {seedMarket} from './support/market.js';
import {migratedPglite} from './support/pglite.js';
import {sellViaWebhook,setLedgerConfig} from './support/payouts.js';
// The worker's payout step (docs/23 §6.2-6.3, §9): batches, sends and settles in its cycle, exports payout metrics and the
// ledger invariant gauge, and logs transitions without tokens or payee ids.
async function setup(){
  const {db}=await migratedPglite();
  const m=await seedMarket(db,{groups:2,perGroup:10,buyers:['buyer-1','buyer-2']});
  await setLedgerConfig(db,m.scenario,1,{holdbackDays:0});
  await sellViaWebhook(db,{buyerId:'buyer-1',quantity:2});
  const lines:string[]=[],sink=new Writable({write(chunk,_e,done){lines.push(String(chunk));done();}});
  const metrics=new Metrics();declareWorkerMetrics(metrics);
  const deps={db,log:createLogger('test',sink,'info'),metrics,health:newHealthState('worker'),
    payouts:{rail:new SandboxRail(db),state:newPayoutSweepState(),invariantEverySeconds:0}};
  return {db,m,lines,metrics,deps};
}
const gauge=(text:string,name:string,labels='')=>{const line=text.split('\n').find(l=>l.startsWith(`${name}${labels?`{${labels}}`:''} `));return line?Number(line.split(' ').pop()):undefined;};

test('worker cycles batch, send and settle payouts, and export payout metrics and the ledger invariant gauge',async()=>{
  const {db,lines,metrics,deps}=await setup();
  const first=await workerCycle(deps);
  assert.equal(first.ok,true);assert.equal(first.idle,false,'payout work makes the cycle busy');
  assert.equal((await db.query(`SELECT state FROM demo_payouts`)).rows.every(r=>r.state==='SENT'),true);
  await workerCycle(deps);
  const states=(await db.query(`SELECT state FROM demo_payouts`)).rows.map(r=>r.state);
  assert.ok(states.length>=1&&states.every(s=>s==='SETTLED'),JSON.stringify(states));
  const text=metrics.render();
  assert.equal(gauge(text,'greenchain_payouts','state="SETTLED"'),states.length);
  assert.equal(gauge(text,'greenchain_payout_clearing_paise'),0);
  assert.ok((gauge(text,'greenchain_reversal_reserve_paise')??0)>0);
  assert.equal(gauge(text,'greenchain_ledger_invariant_violations','code="CONSERVATION"'),0);
  assert.ok(gauge(text,'greenchain_payout_last_batch_age_seconds')!==undefined);
  const third=await workerCycle(deps);
  assert.equal(third.idle,true,'nothing left to do');
  const log=lines.join('');
  assert.match(log,/Payout state changed/);
  for(const forbidden of ['SANDBOX-',...(await db.query('SELECT payee_group_id::text AS p FROM demo_payees')).rows.map(r=>r.p)])assert.ok(!log.includes(forbidden),`log leaks ${forbidden}`);
});

test('a failing payout step is isolated: counted and logged, and the rest of the cycle still runs',async()=>{
  const {db,lines,metrics,deps}=await setup();
  const broken={...deps,payouts:{...deps.payouts,rail:{send:async()=>{throw new Error('never');},getByKey:async()=>{throw new Error('never');},voidKey:async()=>{throw new Error('never');},
    tick:async()=>{throw Object.assign(new Error('rail exploded at https://example/SECRET'),{code:'RAIL_BROKEN'});}}}};
  const outcome=await workerCycle(broken);
  assert.equal(outcome.ok,true,'the worker cycle itself succeeds');
  assert.equal(gauge(metrics.render(),'greenchain_payout_sweep_failures_total'),1);
  assert.match(lines.join(''),/Payout step failed/);assert.ok(!lines.join('').includes('SECRET'),'error messages are never logged');
  assert.ok((await db.query('SELECT 1 FROM worker_heartbeat')).rows.length);
});
