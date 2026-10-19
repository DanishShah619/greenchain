import {test} from 'node:test';
import assert from 'node:assert/strict';
import {migratedPglite} from './support/pglite.js';
import {seedIssuedBatch,seedQueuedProof} from './support/seed.js';
test('a recorded verifier decision cannot be changed or deleted',async()=>{
  const {pg,db}=await migratedPglite();
  try{
    const seed=await seedIssuedBatch(db);
    await assert.rejects(db.query(`UPDATE review_decisions SET decision='REJECTED' WHERE id=$1`,[seed.decision]),/review_decisions rows are immutable/);
    await assert.rejects(db.query(`UPDATE review_decisions SET snapshot='{"tampered":true}'::jsonb WHERE id=$1`,[seed.decision]),/immutable/);
    await assert.rejects(db.query('DELETE FROM review_decisions WHERE id=$1',[seed.decision]),/immutable/);
    const kept=(await db.query('SELECT decision FROM review_decisions WHERE id=$1',[seed.decision])).rows[0];
    assert.equal(kept.decision,'EVIDENCE_APPROVED');
  }finally{await pg.close();}
});
test('credits move only along the legal lifecycle and keep their identity',async()=>{
  const {pg,db}=await migratedPglite();
  try{
    const seed=await seedIssuedBatch(db,3),[a,b,c]=seed.creditIds;
    const move=(id:string,state:string)=>db.query('UPDATE demo_credits SET state=$2 WHERE id=$1',[id,state]);
    const state=async(id:string)=>(await db.query('SELECT state FROM demo_credits WHERE id=$1',[id])).rows[0].state;
    // Legal path: AVAILABLE -> RESERVED -> SOLD -> RETIRED, and a released reservation returns to AVAILABLE.
    await move(a,'RESERVED');await move(a,'SOLD');await move(a,'RETIRED');assert.equal(await state(a),'RETIRED');
    await move(b,'RESERVED');await move(b,'AVAILABLE');assert.equal(await state(b),'AVAILABLE');
    // Skipping a step, going backwards, and leaving a terminal state are all refused.
    await assert.rejects(move(c,'SOLD'),/illegal demo credit transition AVAILABLE -> SOLD/);
    await assert.rejects(move(c,'RETIRED'),/illegal/);
    await move(c,'RESERVED');await move(c,'SOLD');
    await assert.rejects(move(c,'AVAILABLE'),/illegal demo credit transition SOLD -> AVAILABLE/);
    await assert.rejects(move(c,'RESERVED'),/illegal/);
    await assert.rejects(move(a,'AVAILABLE'),/illegal demo credit transition RETIRED -> AVAILABLE/);
    await assert.rejects(move(a,'REVERSED'),/illegal/);
    // A credit can be reversed from any live state, and REVERSED is terminal.
    await move(c,'REVERSED');await assert.rejects(move(c,'SOLD'),/illegal/);
    // Identity columns never change, rows are never deleted, and new credits start AVAILABLE.
    await assert.rejects(db.query(`UPDATE demo_credits SET id='renamed' WHERE id=$1`,[b]),/identity is immutable/);
    await assert.rejects(db.query('UPDATE demo_credits SET ordinal=99 WHERE id=$1',[b]),/identity is immutable/);
    await assert.rejects(db.query('DELETE FROM demo_credits WHERE id=$1',[b]),/cannot be deleted/);
    await assert.rejects(db.query(`INSERT INTO demo_credits(id,batch_id,ordinal,state) VALUES ('late',$1,9,'SOLD')`,[seed.batch]),/must be created AVAILABLE/);
  }finally{await pg.close();}
});
test('a proof status must match the columns it implies',async()=>{
  const {pg,db}=await migratedPglite();
  try{
    const seed=await seedIssuedBatch(db),event=await seedQueuedProof(db,seed.batch);
    const target=`network=80002,contract_address='0xc',signer_address='0xs'`;
    const update=(set:string)=>db.query(`UPDATE demo_chain_proofs SET ${set} WHERE event_id=$1`,[event]);
    const refused=/demo_chain_proofs_status_columns/;
    // QUEUED means nothing about a transaction exists yet.
    await assert.rejects(update('nonce=7'),refused);
    // PREPARED needs the signed bytes, hash, nonce and target before any broadcast.
    await assert.rejects(update(`status='PREPARED',${target},nonce=7,transaction_hash='h'`),refused);
    await update(`status='PREPARED',${target},nonce=7,raw_transaction='bytes',transaction_hash='h'`);
    // PENDING and CONFIRMED need a hash; CONFIRMED also needs where it landed.
    await update(`status='PENDING'`);
    await assert.rejects(update(`status='CONFIRMED',block_number=42`),refused);
    await update(`status='CONFIRMED',block_number=42,block_hash='b',confirmations=12`);
    // A reorganisation may take it back to PENDING (the worker clears the block fields).
    await update(`status='PENDING',block_number=NULL,block_hash=NULL,confirmations=0`);
    // FAILED always says why.
    await assert.rejects(update(`status='FAILED'`),refused);
    await update(`status='FAILED',last_error='CHAIN_TRANSACTION_REVERTED'`);
    await assert.rejects(update('attempts=-1'),refused);
  }finally{await pg.close();}
});
