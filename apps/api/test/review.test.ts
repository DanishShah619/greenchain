import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {buildApp} from '../src/bootstrap/app.js';
import {migratedPglite} from './support/pglite.js';
import {hashPassword} from '../src/kernel/password.js';
import type {Database} from '../src/kernel/database.js';
import {runChainCycle} from '../src/modules/chain/application/worker.js';
import type {ChainPort,Observation,Prepared,ProofIntent} from '../src/modules/chain/application/port.js';
const origin='http://localhost:3000',password='test-password-for-demo-123';
const boundary={type:'Polygon',coordinates:[[[88.5,23.4],[88.501,23.4],[88.501,23.401],[88.5,23.401],[88.5,23.4]]]};
test('proof queue survives uncertain sends, restart, confirmation loss and conflicting effects',async()=>{
  const f=await fixture();try{
    const c=await f.ready(2),body={decisionId:randomUUID(),expectedGeneration:c.selection.generation,inputsHash:c.run.inputs_hash,decision:'APPROVED',reason:'Exact synthetic basis checked before proof creation.'};
    assert.equal((await f.send('POST',`/cases/${c.id}/demo-calculations/${c.run.id}/review`,body,f.verifier)).statusCode,200);
    assert.equal((await runChainCycle(f.db)).proof,'NOT_CONFIGURED');
    const rows=(await f.db.query('SELECT * FROM demo_chain_proofs')).rows;assert.equal(rows.length,1);assert.ok(BigInt(rows[0].anchor_seq)>0n);
    const auditResponse=await f.send('GET',`/cases/${c.id}/audit`);assert.equal(auditResponse.headers['cache-control'],'no-store');const audit=auditResponse.json();assert.equal(audit.audit.status,'VERIFIED');assert.ok(audit.events.length>0);
    assert.equal((await f.send('GET',`/cases/${randomUUID()}/audit`)).statusCode,404);
    let prepares=0,sends=0,fail=true,observation:Observation={status:'ABSENT',confirmations:0};const hashes:string[]=[];
    const fake:ChainPort={identity:{network:80002,contractAddress:'test-contract',signerAddress:'test-signer'},close(){},
      async prepare(_intent:ProofIntent){prepares++;return {rawTransaction:'durable-test-bytes',transactionHash:'test-hash',nonce:7,...this.identity};},
      async inspect(){return observation;},async submit(_intent:ProofIntent,p:Prepared){sends++;hashes.push(p.transactionHash);if(fail)throw new Error('Unknown RPC outcome');}};
    assert.equal((await runChainCycle(f.db,fake)).proof,'RETRY_PENDING');assert.equal(prepares,1);
    let job=(await f.db.query('SELECT * FROM demo_chain_proofs')).rows[0];assert.equal(job.status,'RECONCILING');assert.equal(job.nonce,7);assert.equal(job.raw_transaction,'durable-test-bytes');
    await assert.rejects(f.db.query("UPDATE demo_chain_proofs SET raw_transaction='replacement'"));
    await assert.rejects(f.db.query('DELETE FROM demo_chain_proofs'));await assert.rejects(f.db.query('DELETE FROM demo_registry_events'));
    await assert.rejects(f.db.query("UPDATE demo_registry_events SET payload='{}'::jsonb"));await assert.rejects(f.db.query("UPDATE demo_chain_proofs SET contract_address='new-contract'"));
    fail=false;await f.db.query('UPDATE demo_chain_proofs SET next_attempt_at=now()');
    assert.equal((await runChainCycle(f.db,fake)).proof,'PENDING');assert.equal(prepares,1);assert.equal(sends,2);assert.deepEqual(hashes,['test-hash','test-hash']);
    observation={status:'CONFIRMED',confirmations:12,transactionHash:'test-hash',blockNumber:42,blockHash:'block-hash'};await f.db.query('UPDATE demo_chain_proofs SET next_attempt_at=now()');
    assert.equal((await runChainCycle(f.db,fake)).proof,'CONFIRMED');assert.ok((await f.db.query('SELECT processed_at FROM demo_registry_events')).rows[0].processed_at);
    observation={status:'ABSENT',confirmations:0};await f.db.query('UPDATE demo_chain_proofs SET next_attempt_at=now()');
    assert.equal((await runChainCycle(f.db,fake)).proof,'PENDING');assert.equal(prepares,1);assert.equal((await f.db.query('SELECT processed_at FROM demo_registry_events')).rows[0].processed_at,null);
    observation={status:'RECONCILING',confirmations:0,error:'CHAIN_PROOF_CONFLICT'};await f.db.query('UPDATE demo_chain_proofs SET next_attempt_at=now()');
    assert.equal((await runChainCycle(f.db,fake)).proof,'RECONCILING');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_credits')).rows[0].n,2);
    // Case authorization applies to audit reads even though the global verifier sees only hashes/counts.
    await f.db.query("UPDATE users SET scenario_id='other' WHERE id='presenter'");assert.equal((await f.send('GET',`/cases/${c.id}/audit`)).statusCode,404);
  }finally{await f.close();}
});
async function fixture(){
  const {pg,db}=await migratedPglite();
  await db.query("INSERT INTO scenarios(id) VALUES ('presenter'),('other')");
  await db.query("INSERT INTO demo_namespaces(scenario_id) VALUES ('presenter')");
  await db.query("INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('presenter','presenter','agent',$1),('verifier','presenter','verifier',$1)",[hashPassword(password)]);
  await db.query("INSERT INTO review_mandates VALUES ('verifier','presenter','demo-institution')");
  const app=await buildApp(db,{origin,secure:false});
  async function login(account='presenter'){
    const response=await app.inject({method:'POST',url:'/api/v1/session',headers:{origin},payload:{password,account}});assert.equal(response.statusCode,200);
    return {origin,cookie:`session=${response.cookies[0].value}`,'x-csrf-token':response.json().csrf};
  }
  const agent=await login(),verifier=await login('verifier');
  const send=(method:any,url:string,payload?:any,headers=agent)=>app.inject({method,url:'/api/v1'+url,headers,payload});
  async function create(){const id=randomUUID();assert.equal((await send('POST','/captures',{eventId:id,farmerLabel:'Synthetic case',village:'Demo',areaHectares:'50.00',consent:true,onboarding:{version:1,language:'en',district:'Nadia',plotLabel:'Demo plot',landRight:'owner',crop:'Rice',season:'kharif',consentVersion:'demo-consent-v2',purpose:'demo-onboarding'}})).statusCode,201);return id;}
  const image=await sharp({create:{width:400,height:300,channels:3,background:'#edf3e6'}}).png().toBuffer();
  async function upload(id:string,slot:string,bytes=image,sha=createHash('sha256').update(bytes).digest('hex')){
    const uploadId=randomUUID(),payload={uploadId,slot,mime:'image/png',size:bytes.length,sha256:sha,filename:'synthetic.png'};
    const begin=await send('POST',`/cases/${id}/uploads`,payload);assert.equal(begin.statusCode,200);
    return {uploadId,payload,bytes};
  }
  async function complete(id:string,slot:string){const u=await upload(id,slot);assert.equal((await send('PUT',`/uploads/${u.uploadId}/chunks/0`,{data:u.bytes.toString('base64')})).statusCode,200);assert.equal((await send('POST',`/uploads/${u.uploadId}/complete`)).statusCode,200);return u;}
  async function ready(scale=1,preset='standard'){
    const id=await create(),ring=[[88.5,23.4],[88.5+0.001*scale,23.4],[88.5+0.001*scale,23.4+0.001*scale],[88.5,23.4+0.001*scale],[88.5,23.4]];
    assert.equal((await send('PUT',`/cases/${id}/boundary`,{requestId:randomUUID(),expectedVersion:1,boundary:{type:'Polygon',coordinates:[ring]}})).statusCode,200);
    await complete(id,'land_rights');await complete(id,'plot_photo');
    const draft=(await send('GET',`/cases/${id}`)).json();await send('POST',`/cases/${id}/submit`,{expectedVersion:draft.case.version});
    const submitted=(await send('GET',`/cases/${id}`)).json();
    await send('POST',`/verification/cases/${id}/decision`,{decisionId:randomUUID(),expectedVersion:submitted.case.version,decision:'EVIDENCE_APPROVED',reason:'Synthetic boundary and proof images reviewed.'},verifier);
    const approved=(await send('GET',`/cases/${id}`)).json();
    const calculated=await send('POST',`/cases/${id}/demo-calculations`,{requestId:randomUUID(),expectedVersion:approved.case.version,preset});assert.equal(calculated.statusCode,201);
    const history=(await send('GET',`/cases/${id}/demo-calculations`)).json();
    return {id,run:calculated.json().run,selection:history.selection,version:approved.case.version};
  }
  return {db,app,send,create,upload,complete,ready,agent,verifier,close:async()=>{await app.close();await pg.close();}};
}

test('exact calculation review selects one basis and concurrent retries issue one credit batch',async()=>{
  const f=await fixture();try{
    const c=await f.ready(2);
    const older={decisionId:randomUUID(),expectedGeneration:c.selection.generation,inputsHash:c.run.inputs_hash,decision:'APPROVED',reason:'Exact demo calculation and buffer policy reviewed.'};
    const next=await f.send('POST',`/cases/${c.id}/demo-calculations`,{requestId:randomUUID(),expectedVersion:c.version,preset:'cloudy'});assert.equal(next.statusCode,201);
    assert.equal((await f.send('POST',`/cases/${c.id}/demo-calculations/${c.run.id}/review`,older,f.verifier)).json().code,'STALE_CALCULATION');
    const history=(await f.send('GET',`/cases/${c.id}/demo-calculations`)).json();
    const submitBody={requestId:randomUUID(),expectedGeneration:history.selection.generation,inputsHash:c.run.inputs_hash};
    const submitted=await f.send('POST',`/cases/${c.id}/demo-calculations/${c.run.id}/submit`,submitBody);assert.equal(submitted.statusCode,200);
    assert.equal((await f.send('POST',`/cases/${c.id}/demo-calculations/${c.run.id}/submit`,submitBody)).json().generation,submitted.json().generation);
    const decision={...older,expectedGeneration:submitted.json().generation};
    assert.equal((await f.send('POST',`/cases/${c.id}/demo-calculations/${c.run.id}/review`,decision)).statusCode,403);
    await f.db.query('UPDATE demo_calculation_runs SET actor_id=actor_id WHERE id=$1',[c.run.id]).then(()=>assert.fail('Run should be immutable'),()=>{});
    const responses=await Promise.all([decision,{...decision,decisionId:randomUUID()}].map(payload=>f.send('POST',`/cases/${c.id}/demo-calculations/${c.run.id}/review`,payload,f.verifier)));
    assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,409]);
    const winner=responses.find(r=>r.statusCode===200)!.json();assert.equal(winner.issuance.credit_count,2);
    const original=responses[0].statusCode===200?decision:{...decision,decisionId:winner.review.id};
    assert.equal((await f.send('POST',`/cases/${c.id}/demo-calculations/${c.run.id}/review`,original,f.verifier)).json().replayed,true);
    const inventory=(await f.send('GET',`/cases/${c.id}/demo-issuance`)).json();assert.equal(inventory.credits.length,2);assert.equal(new Set(inventory.credits.map((credit:any)=>credit.id)).size,2);assert.equal(inventory.batch.run_id,c.run.id);assert.equal(inventory.batch.review_id,winner.review.id);assert.equal(inventory.proofStatus,'NOT_CONFIGURED');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_registry_events')).rows[0].n,1);
    assert.equal((await f.send('POST',`/cases/${c.id}/demo-calculations`,{requestId:randomUUID(),expectedVersion:c.version,preset:'no-uplift'})).json().code,'CALCULATION_LOCKED');
    assert.equal((await f.send('POST',`/cases/${c.id}/demo-calculations/${next.json().run.id}/submit`,{requestId:randomUUID(),expectedGeneration:submitted.json().generation,inputsHash:next.json().run.inputs_hash})).statusCode,409);
    await assert.rejects(()=>f.db.query('DELETE FROM demo_calculation_reviews WHERE id=$1',[winner.review.id]));
    await assert.rejects(()=>f.db.query('UPDATE demo_issuance_batches SET credit_count=99 WHERE id=$1',[inventory.batch.id]));
  }finally{await f.close();}
});
test('sub-tonne, rejected and Needs visit calculations preserve issuance gates',async()=>{
  const f=await fixture();try{
    const small=await f.ready();
    const review=await f.send('POST',`/cases/${small.id}/demo-calculations/${small.run.id}/review`,{decisionId:randomUUID(),expectedGeneration:small.selection.generation,inputsHash:small.run.inputs_hash,decision:'APPROVED',reason:'Sub-tonne synthetic estimate and buffer checked.'},f.verifier);
    assert.equal(review.statusCode,200);assert.equal(review.json().issuance.credit_count,0);assert.equal(review.json().issuance.carry_co2e,small.run.result.netCo2e);
    const needs=await f.ready(1,'insufficient'),body={decisionId:randomUUID(),expectedGeneration:needs.selection.generation,inputsHash:needs.run.inputs_hash,decision:'APPROVED',reason:'Synthetic low-confidence result requires a visit.'};
    assert.equal((await f.send('POST',`/cases/${needs.id}/demo-calculations/${needs.run.id}/review`,body,f.verifier)).json().code,'VISIT_REQUIRED');
    assert.equal((await f.send('POST',`/cases/${needs.id}/demo-calculations/${needs.run.id}/review`,{...body,decision:'REJECTED'},f.verifier)).statusCode,200);
    assert.equal((await f.send('GET',`/cases/${needs.id}/demo-issuance`)).json().batch,null);
    assert.equal((await f.send('POST',`/cases/${needs.id}/demo-calculations/${needs.run.id}/submit`,{requestId:randomUUID(),expectedGeneration:needs.selection.generation,inputsHash:needs.run.inputs_hash})).json().code,'CALCULATION_ALREADY_REVIEWED');
    const alternative=(await f.send('POST',`/cases/${needs.id}/demo-calculations`,{requestId:randomUUID(),expectedVersion:needs.version,preset:'cloudy'})).json().run;
    await assert.rejects(()=>f.db.query(`INSERT INTO demo_calculation_reviews(id,scenario_id,capture_id,run_id,reviewer_id,decision,reason,inputs_hash,generation,request_hash)
      VALUES ($1,'presenter',$2,$3,'verifier','REJECTED','Cross-case mismatch test',$4,1,'fixture')`,[randomUUID(),small.id,alternative.id,alternative.inputs_hash]),(error:any)=>error.code==='23503');
    await f.db.query("DELETE FROM review_mandates WHERE user_id='verifier'");
    assert.equal((await f.send('GET',`/cases/${small.id}/demo-issuance`,undefined,f.verifier)).statusCode,404);
  }finally{await f.close();}
});
test('issuance failure rolls back review, basis, credits, buffer and outbox together',async()=>{
  const f=await fixture();try{
    const c=await f.ready(2);await f.db.query('ALTER TABLE demo_registry_events RENAME TO unavailable_registry_events');
    const failed=await f.send('POST',`/cases/${c.id}/demo-calculations/${c.run.id}/review`,{decisionId:randomUUID(),expectedGeneration:c.selection.generation,inputsHash:c.run.inputs_hash,decision:'APPROVED',reason:'Synthetic result has been independently checked.'},f.verifier);assert.equal(failed.statusCode,500);
    for(const table of ['demo_calculation_reviews','demo_issuance_batches','demo_credits'])assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
    assert.equal((await f.db.query('SELECT approved_review_id FROM demo_calculation_state WHERE capture_id=$1',[c.id])).rows[0].approved_review_id,null);
  }finally{await f.close();}
});
test('complete capture → polygon → resumed proof uploads → submission → immutable verifier decision',async()=>{
  const f=await fixture();try{
    const id=await f.create();
    assert.equal((await f.send('POST',`/cases/${id}/submit`,{expectedVersion:1})).statusCode,422);
    const requestId=randomUUID();const plotted=await f.send('PUT',`/cases/${id}/boundary`,{requestId,expectedVersion:1,boundary});assert.equal(plotted.statusCode,200);
    assert.ok(Number(plotted.json().areaHectares)<2); // Declared 50 ha is not authoritative.
    assert.equal((await f.send('PUT',`/cases/${id}/boundary`,{requestId,expectedVersion:1,boundary})).statusCode,200);
    const u=await f.upload(id,'land_rights');
    assert.equal((await f.send('POST',`/uploads/${u.uploadId}/complete`)).statusCode,409);
    const chunk={data:u.bytes.toString('base64')};
    assert.equal((await f.send('PUT',`/uploads/${u.uploadId}/chunks/0`,chunk)).statusCode,200);
    assert.equal((await f.send('PUT',`/uploads/${u.uploadId}/chunks/0`,chunk)).statusCode,200);
    const resume=await f.send('POST',`/cases/${id}/uploads`,u.payload);assert.deepEqual(resume.json().received,[0]);
    assert.equal((await f.send('POST',`/uploads/${u.uploadId}/complete`)).statusCode,200);
    assert.equal((await f.send('POST',`/uploads/${u.uploadId}/complete`)).statusCode,200);
    const afterOne=(await f.send('GET',`/cases/${id}`)).json();assert.deepEqual(afterOne.missing,['plot_photo']);
    assert.equal((await f.send('POST',`/cases/${id}/submit`,{expectedVersion:afterOne.case.version})).statusCode,422);
    await f.complete(id,'plot_photo');
    const ready=(await f.send('GET',`/cases/${id}`)).json();
    assert.equal((await f.send('POST',`/cases/${id}/submit`,{expectedVersion:ready.case.version-1})).statusCode,409);
    assert.equal((await f.send('POST',`/cases/${id}/submit`,{expectedVersion:ready.case.version})).statusCode,200);
    const submitted=(await f.send('GET',`/cases/${id}`,undefined,f.verifier)).json();
    const decision={decisionId:randomUUID(),expectedVersion:submitted.case.version,decision:'EVIDENCE_APPROVED',reason:'Both synthetic proof images reviewed.'};
    assert.equal((await f.send('POST',`/verification/cases/${id}/decision`,decision)).statusCode,403);
    await f.db.query('UPDATE captures SET actor_id=$1 WHERE event_id=$2',['verifier',id]);
    const self=await f.send('POST',`/verification/cases/${id}/decision`,decision,f.verifier);assert.equal(self.statusCode,403);assert.equal(self.json().code,'SELF_REVIEW');
    await f.db.query('UPDATE captures SET actor_id=$1 WHERE event_id=$2',['presenter',id]);
    assert.equal((await f.send('POST',`/verification/cases/${id}/decision`,decision,f.verifier)).statusCode,200);
    assert.equal((await f.send('POST',`/verification/cases/${id}/decision`,decision,f.verifier)).json().replayed,true);
    assert.equal((await f.send('POST',`/verification/cases/${id}/decision`,{...decision,decisionId:randomUUID(),decision:'REJECTED'},f.verifier)).statusCode,409);
    assert.equal((await f.send('PUT',`/cases/${id}/boundary`,{requestId:randomUUID(),expectedVersion:submitted.case.version,boundary})).statusCode,409);
    const preview=await f.send('GET',`/uploads/${u.uploadId}/preview`,undefined,f.verifier);assert.equal(preview.statusCode,200);assert.equal(preview.headers['cache-control'],'no-store');assert.ok(preview.rawPayload.length>0);
    const decisions=(await f.db.query('SELECT * FROM review_decisions')).rows;assert.equal(decisions.length,1);assert.equal(decisions[0].snapshot.evidence.length,2);
    const calc={requestId:randomUUID(),expectedVersion:submitted.case.version+1,preset:'standard'};
    assert.equal((await f.send('POST',`/cases/${id}/demo-calculations`,{...calc,grossCo2e:'9999.0000'})).statusCode,400);
    assert.equal((await f.send('POST',`/cases/${id}/demo-calculations`,calc,f.verifier)).statusCode,403);
    assert.equal((await f.send('POST',`/cases/${id}/demo-calculations`,{...calc,expectedVersion:calc.expectedVersion-1})).statusCode,409);
    const computed=await f.send('POST',`/cases/${id}/demo-calculations`,calc);assert.equal(computed.statusCode,201);
    const run=computed.json().run;assert.equal(run.namespace,'DEMO_ONLY');assert.equal(run.result.trace.areaHectares,plotted.json().areaHectares);assert.equal(run.evidence_decision_id,decision.decisionId);assert.equal(run.inputs_hash.length,64);
    assert.equal((await f.send('POST',`/cases/${id}/demo-calculations`,calc)).json().replayed,true);
    assert.equal((await f.send('POST',`/cases/${id}/demo-calculations`,{...calc,requestId:randomUUID()})).json().run.id,run.id);
    assert.equal((await f.send('POST',`/cases/${id}/demo-calculations`,{...calc,preset:'cloudy'})).statusCode,409);
    for(const preset of ['cloudy','no-uplift','insufficient']){
      const response=await f.send('POST',`/cases/${id}/demo-calculations`,{...calc,requestId:randomUUID(),preset});assert.equal(response.statusCode,201);
      if(preset==='insufficient'){assert.equal(response.json().run.outcome,'NEEDS_VISIT');assert.equal(response.json().run.result.netCo2e,null);}
      if(preset==='no-uplift')assert.equal(response.json().run.result.grossCo2e,'0.0000');
    }
    assert.equal((await f.send('GET',`/cases/${id}/demo-calculations`,undefined,f.verifier)).json().runs.length,4);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type='demo.calculation.recorded'")).rows[0].n,4);
    await assert.rejects(()=>f.db.query('UPDATE demo_calculation_runs SET preset=$1 WHERE id=$2',['cloudy',run.id]));
    await assert.rejects(()=>f.db.query('DELETE FROM demo_calculation_runs WHERE id=$1',[run.id]));
    await f.db.query('UPDATE plots SET area_hectares=$1 WHERE capture_id=$2',['99.0000',id]);
    assert.equal((await f.send('POST',`/cases/${id}/demo-calculations`,{...calc,requestId:randomUUID()})).json().code,'STALE_EVIDENCE');
    // A separate fully submitted case exercises the immutable rejection branch.
    const rejectedId=await f.create();
    await f.send('PUT',`/cases/${rejectedId}/boundary`,{requestId:randomUUID(),expectedVersion:1,boundary});
    await f.complete(rejectedId,'land_rights');await f.complete(rejectedId,'plot_photo');
    const rejecting=(await f.send('GET',`/cases/${rejectedId}`)).json();
    await f.send('POST',`/cases/${rejectedId}/submit`,{expectedVersion:rejecting.case.version});
    const rejection={decisionId:randomUUID(),expectedVersion:rejecting.case.version+1,decision:'REJECTED',reason:'Synthetic evidence does not support the claimed right.'};
    assert.equal((await f.send('POST',`/verification/cases/${rejectedId}/decision`,rejection,f.verifier)).statusCode,200);
    assert.equal((await f.send('GET',`/cases/${rejectedId}`)).json().case.state,'REJECTED');
    assert.equal((await f.send('POST',`/cases/${rejectedId}/demo-calculations`,{requestId:randomUUID(),expectedVersion:rejection.expectedVersion+1,preset:'standard'})).json().code,'EVIDENCE_NOT_APPROVED');
  }finally{await f.close();}
});
test('invalid images and hash mismatches cannot unlock review; mandates and scopes protect proofs',async()=>{
  const f=await fixture();try{
    const id=await f.create(),bad=await f.upload(id,'land_rights',Buffer.from('not a png'));
    assert.equal((await f.send('POST',`/cases/${id}/demo-calculations`,{requestId:randomUUID(),expectedVersion:1,preset:'standard'})).json().code,'EVIDENCE_NOT_APPROVED');
    await f.send('PUT',`/uploads/${bad.uploadId}/chunks/0`,{data:bad.bytes.toString('base64')});
    const invalid=await f.send('POST',`/uploads/${bad.uploadId}/complete`);assert.equal(invalid.statusCode,422);assert.equal(invalid.json().code,'INVALID_IMAGE');
    const mismatch=await f.upload(id,'plot_photo',Buffer.from('synthetic'), '0'.repeat(64));
    await f.send('PUT',`/uploads/${mismatch.uploadId}/chunks/0`,{data:mismatch.bytes.toString('base64')});
    assert.equal((await f.send('POST',`/uploads/${mismatch.uploadId}/complete`)).json().code,'HASH_MISMATCH');
    assert.equal((await f.send('GET',`/uploads/${bad.uploadId}/preview`)).statusCode,409);
    await f.db.query("DELETE FROM review_mandates WHERE user_id='verifier'");
    assert.equal((await f.send('GET',`/cases/${id}`,undefined,f.verifier)).statusCode,404);
    assert.equal((await f.send('GET',`/cases/${id}/demo-calculations`,undefined,f.verifier)).statusCode,404);
    assert.equal((await f.send('GET',`/uploads/${bad.uploadId}/preview`,undefined,f.verifier)).statusCode,404);
    assert.equal((await f.send('GET','/verification/cases',undefined,f.verifier)).json().cases.length,0);
    await f.db.query("DELETE FROM demo_namespaces WHERE scenario_id='presenter'");
    assert.equal((await f.send('POST',`/cases/${id}/demo-calculations`,{requestId:randomUUID(),expectedVersion:1,preset:'standard'})).json().code,'DEMO_SCOPE_ONLY');
    await f.db.query("UPDATE users SET scenario_id='other' WHERE id='presenter'");
    assert.equal((await f.send('GET',`/cases/${id}`)).statusCode,404);
    assert.equal((await f.send('PUT',`/uploads/${bad.uploadId}/chunks/0`,{data:bad.bytes.toString('base64')})).statusCode,404);
  }finally{await f.close();}
});
