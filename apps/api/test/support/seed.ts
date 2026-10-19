import {randomUUID} from 'node:crypto';
import type {Database} from '../../src/kernel/database.js';
/**
 * Inserts the smallest valid chain of rows that satisfies every foreign key down to an issued batch:
 * scenario, user, capture, evidence decision, calculation run, calculation review, issuance batch.
 * Used by constraint tests that must write straight to the tables (the HTTP flow would hide the constraint under test).
 */
export async function seedIssuedBatch(db:Database,credits=1){
  const ids={scenario:'seed-scenario',user:'seed-verifier',capture:randomUUID(),decision:randomUUID(),run:randomUUID(),review:randomUUID(),batch:randomUUID()};
  await db.query('INSERT INTO scenarios(id) VALUES ($1)',[ids.scenario]);
  await db.query('INSERT INTO demo_namespaces(scenario_id) VALUES ($1)',[ids.scenario]);
  await db.query(`INSERT INTO users(id,scenario_id,role,password_hash) VALUES ($1,$2,'verifier','x')`,[ids.user,ids.scenario]);
  await db.query(`INSERT INTO captures(scenario_id,event_id,actor_id,fingerprint,farmer_label,village,area_hectares) VALUES ($1,$2,'seed-agent','f','Synthetic','Demo',1.25)`,[ids.scenario,ids.capture]);
  await db.query(`INSERT INTO review_decisions(id,scenario_id,capture_id,reviewer_id,decision,reason,fingerprint,snapshot) VALUES ($1,$2,$3,$4,'EVIDENCE_APPROVED','Synthetic evidence approved','f','{}'::jsonb)`,[ids.decision,ids.scenario,ids.capture,ids.user]);
  await db.query(`INSERT INTO demo_calculation_runs(id,scenario_id,capture_id,actor_id,evidence_decision_id,methodology_version,parameter_version,preset,inputs_hash,inputs,result,outcome)
    VALUES ($1,$2,$3,'seed-agent',$4,'m','p','standard','h','{}'::jsonb,'{}'::jsonb,'CALCULATED')`,[ids.run,ids.scenario,ids.capture,ids.decision]);
  await db.query(`INSERT INTO demo_calculation_reviews(id,scenario_id,capture_id,run_id,reviewer_id,decision,reason,inputs_hash,generation,request_hash)
    VALUES ($1,$2,$3,$4,$5,'APPROVED','Synthetic calculation approved','h',1,'r')`,[ids.review,ids.scenario,ids.capture,ids.run,ids.user]);
  // gross 2.0000 = buffer 0.2000 + net 1.8000; net = 1 whole credit + 0.8000 carry (matches the batch CHECK constraints).
  await db.query(`INSERT INTO demo_issuance_batches(id,scenario_id,capture_id,run_id,review_id,vintage,gross_co2e,buffer_co2e,net_co2e,credit_count,carry_co2e,inputs_hash)
    VALUES ($1,$2,$3,$4,$5,2026,2.0000,0.2000,1.8000,1,0.8000,'h')`,[ids.batch,ids.scenario,ids.capture,ids.run,ids.review]);
  const creditIds:string[]=[];
  for(let ordinal=1;ordinal<=credits;ordinal++){
    const id=`DEMO-2026-${ids.batch}-${String(ordinal).padStart(6,'0')}`;
    await db.query('INSERT INTO demo_credits(id,batch_id,ordinal) VALUES ($1,$2,$3)',[id,ids.batch,ordinal]);
    creditIds.push(id);
  }
  return {...ids,creditIds};
}
/** A QUEUED proof (the state the issuance flow creates) for the seeded batch. */
export async function seedQueuedProof(db:Database,batchId:string){
  const eventId=randomUUID();
  await db.query(`INSERT INTO demo_registry_events(id,batch_id,event_type,payload) VALUES ($1,$2,'demo.credits.issued','{}'::jsonb)`,[eventId,batchId]);
  await db.query(`INSERT INTO demo_chain_proofs(event_id,batch_id,commitment,anchor_seq,anchor_hash) VALUES ($1,$2,'c',1,'a')`,[eventId,batchId]);
  return eventId;
}
