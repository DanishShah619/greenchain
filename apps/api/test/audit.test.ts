import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migratedPglite} from './support/pglite.js';
import {capture} from '../src/modules/capture/application/capture.js';
import {appendAudit,auditIntegrity,caseAudit,chainAudit,verifyAuditFull,verifyAuditIncremental} from '../src/modules/audit/application/audit.js';
import {claimSigner,queueProofs,runChainCycle,withFence} from '../src/modules/chain/application/worker.js';
import type {Database} from '../src/kernel/database.js';
const actor={id:'test-agent',scenarioId:'demo',role:'agent'};
async function fixture(){
  const {pg,db}=await migratedPglite();await db.query("INSERT INTO scenarios VALUES('demo')");
  const id=randomUUID();
  await capture(db,actor,{eventId:id,farmerLabel:'Synthetic private label',village:'Private village',areaHectares:'1.25',consent:true});
  return {pg,db,id};
}
const chainAll=async(db:Database,size=100)=>{for(;;)if((await chainAudit(db,size)).processed===0)return;};
const disableImmutability=(pg:{exec:(sql:string)=>Promise<unknown>})=>pg.exec('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
test('audit MACs, committed ordering, legacy labels and database append-only guards',async()=>{
  const f=await fixture();try{
    const raw=(await f.db.query('SELECT * FROM audit_events')).rows[0];assert.equal(raw.signed_record.origin,'AT_WRITE');
    assert.ok(!JSON.stringify(raw.signed_record).includes('test-agent'));assert.ok(!JSON.stringify(raw.signed_record).includes('Synthetic private'));
    const before=await auditIntegrity(f.db);assert.equal(before.pendingEvents,1);assert.equal(before.headSequence,'0');
    await assert.rejects(f.db.query('DELETE FROM audit_events'));await assert.rejects(f.db.query("UPDATE audit_events SET event_type='changed'"));
    await f.db.query("INSERT INTO audit_events(id,scenario_id,capture_id,actor_id,event_type) VALUES($1,'demo',$2,'legacy','legacy.event')",[randomUUID(),f.id]);
    await Promise.all([chainAudit(f.db,1),chainAudit(f.db,1)]);
    const verified=await verifyAuditFull(f.db);assert.equal(verified.sequence,'2');assert.equal(verified.pending,0);assert.equal(verified.legacyBackfilled,1);
    await assert.rejects(f.db.query('DELETE FROM audit_chain_links'));
    // A database administrator can bypass triggers; full verification still detects the altered committed row.
    await disableImmutability(f.pg);
    await f.db.query("UPDATE audit_events SET event_type='forged' WHERE id=$1",[raw.id]);
    await assert.rejects(verifyAuditFull(f.db),{code:'AUDIT_INTEGRITY_FAILURE'});
  }finally{await f.pg.close();}
});
test('a corrupt unchained MAC prevents commitment, is recorded as a sticky failure, and stale signer fences cannot write',async()=>{
  const f=await fixture();try{
    const a=(await claimSigner(f.db))!;assert.ok(a);assert.equal(await claimSigner(f.db),undefined);
    await f.db.query("UPDATE chain_worker_lease SET expires_at=now()-interval '1 second'");const b=(await claimSigner(f.db))!;
    assert.ok(BigInt(b.fence)>BigInt(a.fence));let wrote=false;
    await assert.rejects(withFence(f.db,a,async()=>{wrote=true;}),/CHAIN_LEASE_LOST/);assert.equal(wrote,false);
    await disableImmutability(f.pg);await f.db.query("UPDATE audit_events SET row_mac=repeat('0',64)");
    await assert.rejects(chainAudit(f.db),{code:'AUDIT_INTEGRITY_FAILURE'});assert.equal((await f.db.query('SELECT count(*)::int AS n FROM audit_chain_links')).rows[0].n,0);
    const integrity=await auditIntegrity(f.db);assert.deepEqual([integrity.status,integrity.failureCode],['FAILED','AUDIT_INTEGRITY_FAILURE']);
  }finally{await f.pg.close();}
});
test('incremental verification continues from its checkpoint; only a full pass sees behind it',async()=>{
  const f=await fixture();try{
    for(const name of ['a.event','b.event','c.event'])await appendAudit(f.db,actor,f.id,name);
    await chainAll(f.db);
    // Two links per batch, one batch per call: the checkpoint advances by exactly what was verified.
    let state=await verifyAuditIncremental(f.db,{batchSize:2,maxBatches:1});
    assert.deepEqual([state.status,state.verifiedSequence,state.headSequence,state.behind],['OK','2','4','2']);
    state=await verifyAuditIncremental(f.db,{batchSize:2,maxBatches:5});
    assert.deepEqual([state.verifiedSequence,state.behind],['4','0']);
    assert.deepEqual((await verifyAuditIncremental(f.db)).verifiedSequence,'4');
    // Tampering behind the checkpoint is invisible to the incremental pass by design...
    await disableImmutability(f.pg);
    await f.db.query("UPDATE audit_events SET event_type='forged' WHERE id=(SELECT event_id FROM audit_chain_links WHERE chain_seq=1)");
    assert.equal((await verifyAuditIncremental(f.db)).status,'OK');
    // ...and is caught by the full pass, which records the failure.
    await assert.rejects(verifyAuditFull(f.db),{code:'AUDIT_INTEGRITY_FAILURE'});
    assert.equal((await auditIntegrity(f.db)).status,'FAILED');
  }finally{await f.pg.close();}
});
test('tampering after the checkpoint is caught incrementally and halts chaining and proofs until an operator clears it',async()=>{
  const f=await fixture();try{
    await chainAll(f.db);await verifyAuditIncremental(f.db);
    await appendAudit(f.db,actor,f.id,'later.event');await chainAll(f.db);
    await disableImmutability(f.pg);
    await f.db.query("UPDATE audit_events SET event_type='forged' WHERE id=(SELECT event_id FROM audit_chain_links WHERE chain_seq=2)");
    const state=await verifyAuditIncremental(f.db);
    assert.deepEqual([state.status,state.failureCode,state.verifiedSequence],['FAILED','AUDIT_INTEGRITY_FAILURE','1']);
    // The finding is sticky: new events are not chained, no proof is queued, and the worker halts cleanly instead of crashing.
    await appendAudit(f.db,actor,f.id,'after.failure');
    await assert.rejects(chainAudit(f.db),{code:'AUDIT_INTEGRITY_FAILURE'});
    assert.equal(await queueProofs(f.db),0);
    assert.equal((await runChainCycle(f.db)).proof,'HALTED_INTEGRITY');
    // The application cannot clear it; neither can the checkpoint move backwards.
    await assert.rejects(f.db.query("UPDATE audit_integrity_state SET status='OK',failure_code=NULL"),/operator/);
    await assert.rejects(f.db.query('UPDATE audit_integrity_state SET verified_seq=0'),/backwards/);
  }finally{await f.pg.close();}
});
test('the case audit view exposes only the case, never global chain figures',async()=>{
  const f=await fixture();try{
    await f.db.query("INSERT INTO scenarios VALUES('other')");
    const other={id:'other-agent',scenarioId:'other',role:'agent'},otherCase=randomUUID();
    await capture(f.db,other,{eventId:otherCase,farmerLabel:'Other',village:'Other',areaHectares:'2.00',consent:true});
    await chainAll(f.db);await verifyAuditIncremental(f.db);
    const view=await caseAudit(f.db,'demo',f.id);
    assert.deepEqual([view.status,view.caseEvents],['VERIFIED',{total:1,committed:1,verified:1}]);
    for(const forbidden of ['sequence','headHash','pending','legacyBackfilled','confirmedAnchors'])assert.ok(!(forbidden in view),`${forbidden} must not be exposed`);
    // Activity in another scenario changes nothing the caller can see.
    for(let i=0;i<5;i++)await appendAudit(f.db,other,otherCase,`noise.${i}`);
    await chainAll(f.db);await verifyAuditIncremental(f.db);
    const after=await caseAudit(f.db,'demo',f.id);
    assert.deepEqual({...after,checkedAt:null},{...view,checkedAt:null});
    // A new, unchained event of this case makes it PENDING until it is committed and verified.
    await appendAudit(f.db,actor,f.id,'new.event');
    assert.equal((await caseAudit(f.db,'demo',f.id)).status,'PENDING');
    assert.equal((await caseAudit(f.db,'demo',randomUUID())).status,'PENDING');
  }finally{await f.pg.close();}
});
test('verification has no event-count ceiling and the chainer reads only its queue',{timeout:280000},async()=>{
  const f=await fixture();try{
    const total=10050;
    await f.db.transaction(async tx=>{for(let i=0;i<total;i++)await appendAudit(tx,actor,f.id,'bulk.event');});
    await chainAll(f.db,2000);
    const state=await verifyAuditIncremental(f.db,{batchSize:2000,maxBatches:20});
    assert.deepEqual([state.status,state.headSequence,state.verifiedSequence,state.pendingEvents],['OK',String(total+1),String(total+1),0]);
    const full=await verifyAuditFull(f.db,{batchSize:2000});
    assert.deepEqual([full.sequence,full.pending],[String(total+1),0]);
    assert.equal((await caseAudit(f.db,'demo',f.id)).caseEvents.verified,total+1);
  }finally{await f.pg.close();}
});
