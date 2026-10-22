import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './support/app-fixture.js';
import {migratedPglite} from './support/pglite.js';
import {seedMarket} from './support/market.js';
import type {Database} from '../src/kernel/database.js';
// Database guards from the backend audit (migration 0007): evidence and plots freeze once a case leaves DRAFT, review cases
// follow their state machine, reservation timestamps match the order state, and the market hot paths have indexes.
const boundary={type:'Polygon',coordinates:[[[88.5,23.4],[88.501,23.4],[88.501,23.401],[88.5,23.401],[88.5,23.4]]]};
async function submittedCase(f:Awaited<ReturnType<typeof fixture>>){
  const id=await f.create();
  assert.equal((await f.send('PUT',`/cases/${id}/boundary`,{requestId:randomUUID(),expectedVersion:1,boundary})).statusCode,200);
  await f.complete(id,'land_rights');await f.complete(id,'plot_photo');
  const draft=(await f.send('GET',`/cases/${id}`)).json();
  assert.equal((await f.send('POST',`/cases/${id}/submit`,{expectedVersion:draft.case.version})).statusCode,200);
  return id;
}
const one=async(db:Database,sql:string,values:unknown[])=>(await db.query(sql,values)).rows[0];
test('evidence bytes, uploads and the plot cannot change once the case has left DRAFT',async()=>{
  const f=await fixture();
  try{
    const id=await submittedCase(f);
    const upload=await one(f.db,`SELECT id FROM evidence_uploads WHERE capture_id=$1 AND slot='plot_photo'`,[id]);
    await assert.rejects(f.db.query(`UPDATE plots SET area_hectares=99 WHERE capture_id=$1`,[id]),/plot/i,'plot edit');
    await assert.rejects(f.db.query(`DELETE FROM plots WHERE capture_id=$1`,[id]),/plot/i,'plot delete');
    await assert.rejects(f.db.query(`UPDATE evidence_chunks SET data='\\x00'::bytea WHERE upload_id=$1`,[upload.id]),/immutable|evidence/i,'chunk bytes');
    await assert.rejects(f.db.query(`DELETE FROM evidence_chunks WHERE upload_id=$1`,[upload.id]),/immutable|evidence/i,'chunk delete');
    await assert.rejects(f.db.query(`INSERT INTO evidence_chunks(upload_id,chunk_index,data,sha256) VALUES ($1,7,'\\x00'::bytea,'x')`,[upload.id]),/evidence|upload/i,'extra chunk');
    await assert.rejects(f.db.query(`UPDATE evidence_uploads SET sha256=repeat('a',64) WHERE id=$1`,[upload.id]),/evidence|immutable/i,'upload hash');
    await assert.rejects(f.db.query(`UPDATE evidence_uploads SET preview_data='\\x00'::bytea WHERE id=$1`,[upload.id]),/evidence|immutable/i,'preview');
    await assert.rejects(f.db.query(`DELETE FROM evidence_uploads WHERE id=$1`,[upload.id]),/evidence|immutable/i,'upload delete');
  }finally{await f.close();}
});
test('while DRAFT the agent can still work, but a complete upload needs its preview and a finished one is frozen',async()=>{
  const f=await fixture();
  try{
    const id=await f.create();
    assert.equal((await f.send('PUT',`/cases/${id}/boundary`,{requestId:randomUUID(),expectedVersion:1,boundary})).statusCode,200);
    const u=await f.upload(id,'land_rights');
    await assert.rejects(f.db.query(`UPDATE evidence_uploads SET status='COMPLETE' WHERE id=$1`,[u.uploadId]),'COMPLETE needs a preview');
    await f.complete(id,'plot_photo');
    const done=await one(f.db,`SELECT id FROM evidence_uploads WHERE capture_id=$1 AND slot='plot_photo'`,[id]);
    await assert.rejects(f.db.query(`UPDATE evidence_uploads SET filename='other.png' WHERE id=$1`,[done.id]),/evidence|immutable/i,'a finished upload is frozen even in DRAFT');
    await assert.rejects(f.db.query(`UPDATE evidence_uploads SET status='UPLOADING',preview_data=NULL WHERE id=$1`,[done.id]),'no going back to UPLOADING');
    // The plot can still be redrawn in DRAFT.
    const current=(await f.send('GET',`/cases/${id}`)).json();
    assert.equal((await f.send('PUT',`/cases/${id}/boundary`,{requestId:randomUUID(),expectedVersion:current.case.version,boundary})).statusCode,200);
  }finally{await f.close();}
});
test('review cases follow their state machine; decided cases are final',async()=>{
  const f=await fixture();
  try{
    const id=await submittedCase(f);
    const set=(sql:string)=>f.db.query(`UPDATE review_cases SET ${sql} WHERE capture_id=$1`,[id]);
    await assert.rejects(set(`state='DRAFT'`),/review case/i,'SUBMITTED -> DRAFT');
    await assert.rejects(set(`version=version-1`),/review case/i,'version never decreases');
    await assert.rejects(set(`version=version+1`),/review case/i,'a submitted case is no longer edited');
    const draft=await f.create();
    await assert.rejects(f.db.query(`UPDATE review_cases SET state='EVIDENCE_APPROVED' WHERE capture_id=$1`,[draft]),/review case/i,'DRAFT -> APPROVED skips review');
    const c=(await f.send('GET',`/cases/${id}`)).json();
    assert.equal((await f.send('POST',`/verification/cases/${id}/decision`,{decisionId:randomUUID(),expectedVersion:c.case.version,decision:'EVIDENCE_APPROVED',reason:'Synthetic evidence reviewed and approved.'},f.verifier)).statusCode,200);
    for(const next of ['DRAFT','SUBMITTED','REJECTED'])await assert.rejects(set(`state='${next}'`),/review case/i,`APPROVED -> ${next}`);
    await assert.rejects(set(`version=version+1`),/review case/i,'a decided case is final');
    await assert.rejects(f.db.query(`DELETE FROM review_cases WHERE capture_id=$1`,[id]),/review case/i);
    const capture=randomUUID();
    await f.db.query(`INSERT INTO captures(scenario_id,event_id,actor_id,fingerprint,farmer_label,village,area_hectares) VALUES ('presenter',$1,'presenter','f','x','y',1)`,[capture]);
    await assert.rejects(f.db.query(`INSERT INTO review_cases(scenario_id,capture_id,state) VALUES ('presenter',$1,'SUBMITTED')`,[capture]),/review case/i,'cases start as DRAFT');
  }finally{await f.close();}
});
test('an order that holds credits always has a reservation deadline; an offer never does',async()=>{
  const {db}=await migratedPglite();await seedMarket(db,{groups:2,perGroup:5});
  const insert=(state:string,until:string|null,at:string|null,allocated=1)=>db.query(`INSERT INTO demo_orders(id,scenario_id,buyer_id,request_id,request_hash,quantity,allocated_quantity,state,unit_price_paise,price_effective_from,commission_bps,principal_paise,payable_paise,reserved_until,allocated_at)
    VALUES ($1,'market','buyer-1',$2,'h',1,$3,$4,100,now(),500,$5,$5,$6,$7)`,[randomUUID(),randomUUID(),allocated,state,100*allocated,until,at]);
  await assert.rejects(insert('RESERVED',null,null),'reserved without a deadline would never be reaped');
  await assert.rejects(insert('RESERVED',null,new Date().toISOString()));
  await assert.rejects(insert('CREATED',new Date().toISOString(),null,0),'an offer reserves nothing');
  await insert('CREATED',null,null,0);
  await insert('RESERVED',new Date(Date.now()+60_000).toISOString(),new Date().toISOString());
  await assert.rejects(db.query(`UPDATE demo_orders SET reserved_until=NULL WHERE state='RESERVED'`));
});
test('market hot paths can use an index instead of scanning the table',async()=>{
  const {db}=await migratedPglite();
  await db.query('SET enable_seqscan=off');
  const plan=async(sql:string)=>(await db.query(`EXPLAIN ${sql}`)).rows.map(r=>Object.values(r)[0]).join('\n');
  const cases:[string,string][]=[
    [`SELECT id FROM demo_credits WHERE reserved_order_id=ANY('{00000000-0000-0000-0000-000000000000}'::uuid[]) AND state='RESERVED'`,'demo_credits_reserved_order'],
    [`SELECT kind FROM demo_payment_refunds WHERE order_id='00000000-0000-0000-0000-000000000000'`,'demo_payment_refunds_order'],
    [`SELECT 1 FROM demo_payment_refunds WHERE scenario_id='market' AND state='PENDING' AND created_at<=now()`,'demo_payment_refunds_pending'],
    [`SELECT outcome FROM demo_payment_events WHERE attempt_id='00000000-0000-0000-0000-000000000000'`,'demo_payment_events_attempt'],
    [`SELECT id FROM demo_orders WHERE scenario_id='market' AND state='CREATED' AND created_at<=now()`,'demo_orders_stale_offers'],
  ];
  for(const [sql,index] of cases)assert.match(await plan(sql),new RegExp(index),sql);
});
