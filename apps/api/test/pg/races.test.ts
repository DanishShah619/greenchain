import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,race,testDatabaseUrl} from '../support/pg.js';
import {fixture} from '../support/app-fixture.js';
import {beginUpload} from '../../src/modules/review/application/workflow.js';
import {claimSigner,renewLease,withFence} from '../../src/modules/chain/application/worker.js';
import {chainAudit,verifyAuditFull,verifyAuditIncremental,auditIntegrity} from '../../src/modules/audit/application/audit.js';
import {migrate,loadMigrations} from '../../src/kernel/migrate.js';
const opts={skip:testDatabaseUrl?false:'TEST_DATABASE_URL is not set (the guard test fails loudly in npm run test:pg)'};
const MiB=1024*1024;
const wins=<T>(results:PromiseSettledResult<T|undefined>[])=>results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>(r as PromiseFulfilledResult<T>).value);
test('beginUpload quota: concurrent reservations never exceed 64 MiB and exactly the cap is allowed',opts,async()=>{
  const t=await createTestDatabase(),f=await fixture({db:t.db,close:async()=>{}});
  try{
    // 17 cases x 2 slots = 34 attempts of 2 MiB at once; the 64 MiB cap admits exactly 32.
    const cases:string[]=[];for(let i=0;i<17;i++)cases.push(await f.create());
    const actor={id:'presenter',scenarioId:'presenter',role:'agent'};
    const jobs=cases.flatMap(id=>(['land_rights','plot_photo'] as const).map(slot=>({id,slot})));
    const results=await race(jobs.length,i=>beginUpload(t.db,actor,jobs[i].id,{uploadId:randomUUID(),slot:jobs[i].slot,mime:'image/png',size:2*MiB,sha256:'a'.repeat(64),filename:'x.png'}));
    const ok=results.filter(r=>r.status==='fulfilled'),bad=results.filter(r=>r.status==='rejected') as PromiseRejectedResult[];
    assert.equal(ok.length,32,'exactly 32 x 2 MiB = 64 MiB fits');
    assert.equal(bad.length,2);for(const r of bad)assert.equal((r.reason as any).code,'EVIDENCE_QUOTA');
    const total=Number((await t.db.query(`SELECT coalesce(sum(size),0)::bigint AS s FROM evidence_uploads WHERE scenario_id='presenter'`)).rows[0].s);
    assert.equal(total,64*MiB);
  }finally{await f.close();await t.close();}
});
test('competing approvals of one calculation issue exactly one batch',opts,async()=>{
  const t=await createTestDatabase(),f=await fixture({db:t.db,close:async()=>{}});
  try{
    const c=await f.ready(2);
    const results=await race(8,i=>f.send('POST',`/cases/${c.id}/demo-calculations/${c.run.id}/review`,{decisionId:randomUUID(),expectedGeneration:c.selection.generation,inputsHash:c.run.inputs_hash,decision:'APPROVED',reason:`Concurrent approval attempt number ${i} with exact basis.`},f.verifier));
    const codes=results.map(r=>r.status==='fulfilled'?r.value.statusCode:-1);
    assert.equal(codes.filter(x=>x===200).length,1,`one approval wins, got ${codes.join(',')}`);
    assert.ok(codes.every(x=>x===200||x===409||x===422),`losers are clean conflicts, got ${codes.join(',')}`);
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM demo_issuance_batches')).rows[0].n,1);
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM demo_calculation_reviews')).rows[0].n,1);
    const batch=(await t.db.query('SELECT credit_count FROM demo_issuance_batches')).rows[0];
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM demo_credits')).rows[0].n,batch.credit_count);
    // The same decision id retried concurrently is a replay, never a second effect.
    const body={decisionId:randomUUID(),expectedGeneration:c.selection.generation,inputsHash:c.run.inputs_hash,decision:'APPROVED',reason:'Exact replay of the same approval request.'};
    await race(6,()=>f.send('POST',`/cases/${c.id}/demo-calculations/${c.run.id}/review`,body,f.verifier));
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM demo_issuance_batches')).rows[0].n,1);
  }finally{await f.close();await t.close();}
});
test('signer lease: one concurrent claimant wins, expiry hands over with a higher fence, the old holder is fenced out',opts,async()=>{
  const t=await createTestDatabase();
  try{
    const pools=Array.from({length:6},()=>t.connect());
    const holder=wins(await race(24,i=>claimSigner(pools[i%pools.length],randomUUID(),60)));
    assert.equal(holder.length,1,'exactly one claimant holds the lease');
    await renewLease(t.db,holder[0],60);
    await withFence(t.db,holder[0],async()=>{});
    // Force expiry; again many contend, exactly one takes over with a strictly higher fence.
    await t.db.query(`UPDATE chain_worker_lease SET expires_at=now()-interval '1 second' WHERE id=1`);
    const next=wins(await race(24,i=>claimSigner(pools[i%pools.length],randomUUID(),60)));
    assert.equal(next.length,1);assert.ok(BigInt(next[0].fence)>BigInt(holder[0].fence));
    await assert.rejects(renewLease(t.db,holder[0],60),/CHAIN_LEASE_LOST/);
    await assert.rejects(withFence(t.db,holder[0],async()=>{}),/CHAIN_LEASE_LOST/);
    await withFence(t.db,next[0],async()=>{});
    // An expired holder cannot renew or write even if nobody has taken over yet.
    await t.db.query(`UPDATE chain_worker_lease SET expires_at=now()-interval '1 second' WHERE id=1`);
    await assert.rejects(renewLease(t.db,next[0],60),/CHAIN_LEASE_LOST/);
  }finally{await t.close();}
});
test('concurrent appends and chainers keep one contiguous verified chain',opts,async()=>{
  const t=await createTestDatabase(),f=await fixture({db:t.db,close:async()=>{}});
  try{
    const pools=Array.from({length:4},()=>t.connect());
    // Captures append audit events from many connections while several chainers run at the same time.
    const [made]=await Promise.all([race(12,()=>f.create()),race(8,i=>chainAudit(pools[i%pools.length]))]);
    assert.equal(made.filter(r=>r.status==='fulfilled').length,12);
    for(const r of await race(4,i=>chainAudit(pools[i])))if(r.status==='rejected')assert.fail(`chainer failed: ${(r.reason as any)?.code??'unknown'}`);
    assert.equal((await verifyAuditIncremental(t.db)).status,'OK');
    const full=await verifyAuditFull(t.db);
    const counts=(await t.db.query('SELECT (SELECT count(*)::int FROM audit_events) AS events,(SELECT count(*)::int FROM audit_chain_links) AS links,(SELECT count(*)::int FROM audit_chain_queue) AS queued')).rows[0];
    assert.equal(counts.events,counts.links);assert.equal(counts.queued,0);assert.equal(Number(full.sequence),counts.events);
    assert.equal((await auditIntegrity(t.db)).pendingEvents,0);
  }finally{await f.close();await t.close();}
});
test('concurrent migrators on a fresh database apply each migration once',opts,async()=>{
  const t=await createTestDatabase({migrate:false});
  try{
    const pools=Array.from({length:6},()=>t.connect());
    const results=await race(6,i=>migrate(pools[i]));
    for(const r of results)if(r.status==='rejected')assert.fail(`migrator failed: ${(r.reason as any)?.code??(r.reason as Error).message}`);
    const expected=(await loadMigrations()).length;
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,expected);
    assert.equal(results.filter(r=>r.status==='fulfilled'&&(r.value as any).applied.length>0).length,1,'exactly one runner applied the files');
  }finally{await t.close();}
});
