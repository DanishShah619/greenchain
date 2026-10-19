import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {test} from 'node:test';
import assert from 'node:assert/strict';
test('legacy queue survives upgrade, owner scope, reopen and interrupted acknowledgements',async()=>{
  const legacy=new Dexie('greenchain-demo-captures');
  legacy.version(1).stores({drafts:'eventId,state'});
  await legacy.table('drafts').add({eventId:'legacy-id',farmerLabel:'Legacy demo',village:'Demo',areaHectares:'1.25',consent:true,state:'pending'});
  legacy.close();
  const {drafts,settings,deviceDatabase,syncDrafts}=await import('../src/outbox');
  try{
    const original=await drafts.get('legacy-id');assert.equal(original?.ownerId,'presenter');
    await settings.put({key:'onboarding:presenter',value:{farmerLabel:'Draft farmer',step:1,plotLabel:'Draft plot'}});
    deviceDatabase.close();await deviceDatabase.open();
    assert.deepEqual((await settings.get('onboarding:presenter'))?.value,{farmerLabel:'Draft farmer',step:1,plotLabel:'Draft plot'});
    assert.equal((await drafts.get('legacy-id'))?.state,'pending');
    await assert.rejects(()=>syncDrafts('presenter',async()=>{throw new Error('Acknowledgement lost');}));
    assert.equal((await drafts.get('legacy-id'))?.state,'pending');
    await assert.rejects(()=>syncDrafts('presenter',async()=>({eventId:'wrong-id',status:'CAPTURED'})));
    assert.equal((await drafts.get('legacy-id'))?.state,'pending');
    await drafts.add({...original!,eventId:'other-id',ownerId:'another-agent'});
    const sent:string[]=[];
    assert.deepEqual(await syncDrafts('presenter',async payload=>{sent.push(payload.eventId);assert.equal('ownerId'in payload,false);return {eventId:payload.eventId,status:'CAPTURED'};}),{accepted:1,rejected:0});
    assert.deepEqual(sent,['legacy-id']);
    assert.equal((await drafts.get('legacy-id'))?.state,'synced');
    assert.equal((await drafts.get('other-id'))?.state,'pending');
    // A permanently rejected event must not prevent its valid neighbour syncing.
    await drafts.add({...original!,eventId:'bad-id'});
    await drafts.add({...original!,eventId:'good-id'});
    assert.deepEqual(await syncDrafts('presenter',async payload=>{
      if(payload.eventId==='bad-id')throw Object.assign(new Error('Needs review'),{code:'KEY_REUSE'});
      return {eventId:payload.eventId,status:'CAPTURED'};
    }),{accepted:1,rejected:1});
    assert.equal((await drafts.get('bad-id'))?.state,'rejected');
    assert.equal((await drafts.get('good-id'))?.state,'synced');
    await settings.delete('active-presenter');
    assert.equal((await drafts.get('other-id'))?.state,'pending');
  }finally{await deviceDatabase.delete();}
});
