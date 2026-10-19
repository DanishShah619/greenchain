import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evidence,deviceDatabase,syncEvidence} from '../src/outbox';
test('evidence blobs survive reopen and sync resumes after interrupted completion',async()=>{
  try{
    const blob=new Blob([new Uint8Array(262145).fill(7)],{type:'image/png'});
    await evidence.add({id:'upload-id',ownerId:'presenter',eventId:'capture-id',slot:'plot_photo',blob,mime:'image/png',filename:'synthetic.png',sha256:'a'.repeat(64),state:'pending'});
    deviceDatabase.close();await deviceDatabase.open();
    assert.equal((await evidence.get('upload-id'))?.blob.size,262145);
    const chunks:number[]=[];
    await assert.rejects(()=>syncEvidence('presenter','capture-id',async(path,options)=>{
      if(path.endsWith('/uploads'))return {uploadId:'upload-id',status:'UPLOADING',chunkSize:262144,received:[0]};
      if(path.includes('/chunks/')){const index=Number(path.split('/').at(-1));chunks.push(index);assert.equal(JSON.parse(options!.body as string).data,btoa(String.fromCharCode(7)));return {index,received:true};}
      throw new Error('Connection lost before completion acknowledgement');
    }));
    assert.deepEqual(chunks,[1]);assert.equal((await evidence.get('upload-id'))?.state,'pending');
    await syncEvidence('presenter','capture-id',async path=>{
      if(path.endsWith('/uploads'))return {uploadId:'upload-id',status:'UPLOADING',chunkSize:262144,received:[0,1]};
      assert.ok(path.endsWith('/complete'));return {uploadId:'upload-id',status:'COMPLETE'};
    });
    assert.equal((await evidence.get('upload-id'))?.state,'complete');
    await syncEvidence('another-agent','capture-id',async()=>{assert.fail('Another owner cannot sync this proof');});
  }finally{await deviceDatabase.delete();}
});
