import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {migratedPglite} from './support/pglite.js';
import {seedIssuedBatch,seedQueuedProof} from './support/seed.js';
import {assertPolicy,classifyChainError,DEFAULT_POLICY,policyFromEnvironment,retryDelaySeconds,withDeadline} from '../src/modules/chain/application/policy.js';
import {proofStats,requeueProof,runChainCycle} from '../src/modules/chain/application/worker.js';
import type {ChainPort,Observation,Prepared} from '../src/modules/chain/application/port.js';
import {createLogger} from '../src/kernel/logger.js';
import {Metrics} from '../src/kernel/metrics.js';
import {declareWorkerMetrics,newHealthState,nextSleepMs,workerCycle} from '../src/modules/ops/application/iteration.js';
import {startOpsServer} from '../src/bootstrap/ops-server.js';
import {WorkflowError} from '../src/kernel/errors.js';
const identity={network:80002,contractAddress:'test-contract',signerAddress:'test-signer'};
const failing=(error:Error):ChainPort=>({identity,close(){},async prepare(){throw error;},async submit(){throw error;},async inspect(){return {status:'ABSENT',confirmations:0} as Observation;}});
const signedPort=(submit:()=>Promise<void>,inspect:()=>Promise<Observation>=async()=>({status:'ABSENT',confirmations:0})):ChainPort=>({identity,close(){},
  async prepare():Promise<Prepared>{return {rawTransaction:'raw',transactionHash:'hash',nonce:1,...identity};},submit,inspect});
async function fixture(){
  const created=await migratedPglite(),batch=await seedIssuedBatch(created.db),eventId=await seedQueuedProof(created.db,batch.batch);
  const due=()=>created.db.query('UPDATE demo_chain_proofs SET next_attempt_at=now()');
  const proof=async()=>(await created.db.query('SELECT * FROM demo_chain_proofs WHERE event_id=$1',[eventId])).rows[0];
  return {...created,eventId,due,proof};
}
test('retry delay doubles, is capped, and is jittered within +-20%',()=>{
  const p=DEFAULT_POLICY;
  assert.equal(retryDelaySeconds(1,p,()=>0.5),30);assert.equal(retryDelaySeconds(2,p,()=>0.5),60);assert.equal(retryDelaySeconds(3,p,()=>0.5),120);
  assert.equal(retryDelaySeconds(50,p,()=>0.5),900);
  assert.equal(retryDelaySeconds(1,p,()=>0),24);assert.equal(retryDelaySeconds(1,p,()=>1),36);
});
test('policy validation rejects a lease that could expire mid-call and bad environment values',()=>{
  assert.throws(()=>assertPolicy({...DEFAULT_POLICY,leaseSeconds:30,portCallDeadlineMs:45000}));
  assert.throws(()=>policyFromEnvironment({PROOF_MAX_FAILURES:'0'}));assert.throws(()=>policyFromEnvironment({PROOF_POLL_SECONDS:'abc'}));
  assert.equal(policyFromEnvironment({}).maxFailures,8);
});
test('error classification yields only safe codes and never leaks messages or URLs',()=>{
  const secret=new Error('request to https://rpc.example/v1/SECRETKEY failed');(secret as any).code='ECONNREFUSED';
  assert.equal(classifyChainError(secret),'CHAIN_RPC_UNAVAILABLE');
  const wrapped=new Error('outer https://x/KEY',{cause:Object.assign(new Error('inner'),{code:'TIMEOUT'})});
  assert.equal(classifyChainError(wrapped),'CHAIN_RPC_TIMEOUT');
  assert.equal(classifyChainError(new Error('CHAIN_GAS_LIMIT')),'CHAIN_GAS_LIMIT');
  assert.equal(classifyChainError(new Error('anything https://rpc/KEY')),'CHAIN_UNKNOWN');assert.equal(classifyChainError('string'),'CHAIN_UNKNOWN');
});
test('withDeadline rejects with CHAIN_CYCLE_TIMEOUT when the work never settles',async()=>{
  await assert.rejects(withDeadline(new Promise(()=>{}),20),/CHAIN_CYCLE_TIMEOUT/);
  assert.equal(await withDeadline(Promise.resolve(5),50),5);
});
test('a proof with no transaction fails after maxFailures, then requeue restarts it; a hung call times out',async()=>{
  const f=await fixture();
  const policy={maxFailures:3,portCallDeadlineMs:1000,leaseSeconds:30,baseDelaySeconds:30};
  const opts={policy:{...policy,leaseSeconds:90},random:()=>0.5};
  const port=failing(Object.assign(new Error('boom https://rpc/KEY'),{code:'ECONNRESET'}));
  for(let i=1;i<=2;i++){
    const r=await runChainCycle(f.db,port,opts);assert.equal(r.proof,'RETRY_PENDING');assert.equal(r.error,'CHAIN_RPC_UNAVAILABLE');assert.equal(r.failureCount,i);
    const row=await f.proof();assert.equal(row.status,'QUEUED');assert.equal(row.failure_count,i);assert.equal(row.last_error,'CHAIN_RPC_UNAVAILABLE');await f.due();
  }
  assert.equal((await runChainCycle(f.db,port,opts)).proof,'FAILED');
  let row=await f.proof();assert.equal(row.status,'FAILED');assert.equal(row.failure_count,3);assert.doesNotMatch(String(row.last_error),/KEY|https/);
  await f.due();assert.equal((await runChainCycle(f.db,port,opts)).proof,'IDLE','FAILED proofs are not retried automatically');
  assert.equal((await proofStats(f.db)).byStatus.FAILED,1);
  await assert.rejects(requeueProof(f.db,'00000000-0000-0000-0000-000000000000'),(e:any)=>e instanceof WorkflowError&&e.code==='PROOF_NOT_FOUND');
  assert.equal((await requeueProof(f.db,f.eventId)).status,'QUEUED');
  row=await f.proof();assert.equal(row.status,'QUEUED');assert.equal(row.failure_count,0);assert.equal(row.last_error,null);
  await assert.rejects(requeueProof(f.db,f.eventId),(e:any)=>e.code==='PROOF_NOT_FAILED');
  assert.ok((await f.db.query(`SELECT 1 FROM audit_events WHERE event_type='chain.proof.requeued'`)).rows.length>=1,'requeue is audited');
  const hung:ChainPort={...port,async prepare(){return new Promise<Prepared>(()=>{});}};
  const r=await runChainCycle(f.db,hung,{policy:{...opts.policy,portCallDeadlineMs:1000,leaseSeconds:90},random:()=>0.5});
  assert.equal(r.error,'CHAIN_CYCLE_TIMEOUT');
});
test('a proof that has a signed transaction is never parked as FAILED and a success resets the failure count',async()=>{
  const f=await fixture();const opts={policy:{maxFailures:2},random:()=>0.5};
  let mode:'fail'|'ok'='fail';
  const port=signedPort(async()=>{if(mode==='fail')throw new Error('Unknown RPC outcome');});
  for(let i=0;i<4;i++){assert.equal((await runChainCycle(f.db,port,opts)).proof,'RETRY_PENDING');await f.due();}
  let row=await f.proof();assert.equal(row.status,'RECONCILING');assert.equal(row.failure_count,4);assert.ok(row.transaction_hash);
  mode='ok';assert.equal((await runChainCycle(f.db,port,opts)).proof,'PENDING');
  row=await f.proof();assert.equal(row.failure_count,0);assert.equal(row.last_error,null);
});
test('requeue refuses a FAILED proof that holds a signed transaction',async()=>{
  const f=await fixture();
  await f.db.query(`UPDATE demo_chain_proofs SET status='FAILED',last_error='CHAIN_UNKNOWN',network=80002,contract_address='c',signer_address='s',nonce=1,raw_transaction='raw',transaction_hash='h' WHERE event_id=$1`,[f.eventId]);
  await assert.rejects(requeueProof(f.db,f.eventId),(e:any)=>e.code==='PROOF_HAS_TRANSACTION');
});
test('metrics render valid Prometheus text with escaped labels and reject bad names',()=>{
  const m=new Metrics();m.declare('app_things_total','counter','Things.').declare('app_level','gauge','Level.');
  m.inc('app_things_total',{code:'A"B\\C\nD'});m.inc('app_things_total',{code:'A"B\\C\nD'});m.set('app_level',3);
  const text=m.render();
  assert.match(text,/# TYPE app_things_total counter/);assert.match(text,/app_things_total\{code="A\\"B\\\\C\\nD"\} 2/);assert.match(text,/app_level 3/);
  assert.throws(()=>m.declare('bad name','gauge','x'));
});
test('the logger redacts secrets and never prints configured sensitive fields',()=>{
  const lines:string[]=[];const sink=new Writable({write(chunk,_e,done){lines.push(String(chunk));done();}});
  const log=createLogger('test',sink,'info');
  log.info({privateKey:'0xSECRET',rpcUrl:'https://rpc/KEY',nested:{password:'pw',token:'tok'},ok:'visible'},'hello');
  const out=lines.join('');assert.match(out,/visible/);assert.doesNotMatch(out,/0xSECRET|rpc\/KEY|"pw"|"tok"/);
});
test('the worker cycle never throws, records failures, then recovers and heartbeats',async()=>{
  const f=await fixture();const metrics=new Metrics();declareWorkerMetrics(metrics);const health=newHealthState('test');
  const sink=new Writable({write(_c,_e,done){done();}}),log=createLogger('test',sink,'debug');
  // Break the database for one cycle: a missing table makes the cycle throw inside.
  await f.db.query('ALTER TABLE jobs RENAME TO jobs_gone');
  const bad=await workerCycle({db:f.db,log,metrics,health});
  assert.equal(bad.ok,false);assert.equal(health.consecutiveFailures,1);assert.ok(nextSleepMs(bad,1)>=2000);
  await f.db.query('ALTER TABLE jobs_gone RENAME TO jobs');
  const good=await workerCycle({db:f.db,log,metrics,health});
  assert.equal(good.ok,true);assert.equal(health.consecutiveFailures,0);assert.equal(nextSleepMs(good,0)<=1000,true);
  const beat=(await f.db.query('SELECT * FROM worker_heartbeat WHERE name=$1',['test'])).rows[0];
  assert.equal(beat.cycles,2);assert.equal(beat.failures,1);assert.equal(beat.last_error_code,null);
  const text=metrics.render();assert.match(text,/greenchain_worker_cycles_total\{result="error"\} 1/);assert.match(text,/greenchain_worker_cycles_total\{result="ok"\} 1/);assert.match(text,/greenchain_proofs\{status="QUEUED"\} 1/);
});
test('the ops server reports health and metrics, rejects other methods, and goes 503 when stale',async()=>{
  const metrics=new Metrics();declareWorkerMetrics(metrics);metrics.set('greenchain_jobs_pending',2);
  const health=newHealthState('t',1000);let clock=1000;
  const server=await startOpsServer({port:0,host:'127.0.0.1',metrics,health,maxAgeMs:60_000,now:()=>clock});
  try{
    const base=`http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/healthz`)).status,200,'starting is healthy');
    clock=1000+61_000;assert.equal((await fetch(`${base}/healthz`)).status,503,'no cycle ever completed');
    health.lastSuccessAt=clock;assert.equal((await fetch(`${base}/healthz`)).status,200);
    clock+=61_000;assert.equal((await fetch(`${base}/healthz`)).status,503,'stale');
    health.lastSuccessAt=clock;health.integrityFailed=true;const degraded=await fetch(`${base}/healthz`);assert.equal(degraded.status,503);assert.equal((await degraded.json()).reason,'AUDIT_INTEGRITY_FAILED');
    const m=await fetch(`${base}/metrics`);assert.equal(m.status,200);assert.match(await m.text(),/greenchain_jobs_pending 2/);
    assert.equal((await fetch(`${base}/metrics`,{method:'POST'})).status,405);assert.equal((await fetch(`${base}/nope`)).status,404);
  }finally{await server.close();}
});
