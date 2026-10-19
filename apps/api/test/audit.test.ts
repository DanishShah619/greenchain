import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migratedPglite} from './support/pglite.js';
import {capture} from '../src/modules/capture/application/capture.js';
import {chainAudit,verifyAudit} from '../src/modules/audit/application/audit.js';
import {claimSigner,withFence} from '../src/modules/chain/application/worker.js';
async function fixture(){
  const {pg,db}=await migratedPglite();await db.query("INSERT INTO scenarios VALUES('demo')");
  const actor={id:'test-agent',scenarioId:'demo',role:'agent'},id=randomUUID();
  await capture(db,actor,{eventId:id,farmerLabel:'Synthetic private label',village:'Private village',areaHectares:'1.25',consent:true});
  return {pg,db,id};
}
test('audit MACs, committed ordering, legacy labels and database append-only guards',async()=>{
  const f=await fixture();try{
    const raw=(await f.db.query('SELECT * FROM audit_events')).rows[0];assert.equal(raw.signed_record.origin,'AT_WRITE');
    assert.ok(!JSON.stringify(raw.signed_record).includes('test-agent'));assert.ok(!JSON.stringify(raw.signed_record).includes('Synthetic private'));
    const before=await verifyAudit(f.db);assert.equal(before.pending,1);assert.equal(before.sequence,'0');
    await assert.rejects(f.db.query('DELETE FROM audit_events'));await assert.rejects(f.db.query("UPDATE audit_events SET event_type='changed'"));
    await f.db.query("INSERT INTO audit_events(id,scenario_id,capture_id,actor_id,event_type) VALUES($1,'demo',$2,'legacy','legacy.event')",[randomUUID(),f.id]);
    await Promise.all([chainAudit(f.db,1),chainAudit(f.db,1)]);
    const verified=await verifyAudit(f.db);assert.equal(verified.sequence,'2');assert.equal(verified.pending,0);assert.equal(verified.legacyBackfilled,1);
    await assert.rejects(f.db.query('DELETE FROM audit_chain_links'));
    // A database administrator can bypass triggers; verification still detects the altered committed row.
    await f.pg.exec('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
    await f.db.query("UPDATE audit_events SET event_type='forged' WHERE id=$1",[raw.id]);
    await assert.rejects(verifyAudit(f.db),{code:'AUDIT_INTEGRITY_FAILURE'});
  }finally{await f.pg.close();}
});
test('a corrupt unchained MAC prevents commitment and stale signer fences cannot write',async()=>{
  const f=await fixture();try{
    const a=(await claimSigner(f.db))!;assert.ok(a);assert.equal(await claimSigner(f.db),undefined);
    await f.db.query("UPDATE chain_worker_lease SET expires_at=now()-interval '1 second'");const b=(await claimSigner(f.db))!;
    assert.ok(BigInt(b.fence)>BigInt(a.fence));let wrote=false;
    await assert.rejects(withFence(f.db,a,async()=>{wrote=true;}),/CHAIN_LEASE_LOST/);assert.equal(wrote,false);
    await f.pg.exec('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');await f.db.query("UPDATE audit_events SET row_mac=repeat('0',64)");
    await assert.rejects(chainAudit(f.db),{code:'AUDIT_INTEGRITY_FAILURE'});assert.equal((await f.db.query('SELECT count(*)::int AS n FROM audit_chain_links')).rows[0].n,0);
  }finally{await f.pg.close();}
});
