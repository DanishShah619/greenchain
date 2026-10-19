// Local synthetic smoke. Creates one demo case and uses the two seeded accounts.
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const origin='http://localhost:3000',api='http://localhost:4000/api/v1';
export let lastCaseId;
const scale=Number(process.env.DEMO_BOUNDARY_SCALE??'1');
assert.ok(Number.isFinite(scale)&&scale>=1&&scale<=10,'Synthetic boundary scale must be 1-10');
async function login(account){
  const password=(await readFile(`.local/${account==='presenter'?'presenter':'verifier'}-password.txt`,'utf8')).trim();
  const response=await fetch(`${api}/session`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({account,password})});
  assert.equal(response.status,200,`${account} login`);
  const session=await response.json();assert.equal(session.role,account==='presenter'?'agent':'verifier');
  return {origin,cookie:response.headers.get('set-cookie').split(';')[0],'x-csrf-token':session.csrf};
}
async function call(headers,path,method='GET',body,expected=200){
  const response=await fetch(api+path,{method,headers:{...headers,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const result=response.status===204?{}:await response.json();
  assert.equal(response.status,expected,`${method} ${path}: ${result.code??''}`);return result;
}
const agent=await login('presenter'),verifier=await login('verifier');
try{
  const id=randomUUID(),payload={eventId:id,farmerLabel:'Demo field-review smoke',village:'Synthetic village',areaHectares:'50.00',consent:true,onboarding:{version:1,language:'en',district:'Nadia',plotLabel:'Synthetic plot',landRight:'owner',crop:'Synthetic rice',season:'kharif',consentVersion:'demo-consent-v2',purpose:'demo-onboarding'}};
  lastCaseId=id;
  await call(agent,'/captures','POST',payload,201);
  await call(agent,`/cases/${id}/submit`,'POST',{expectedVersion:1},422);
  const boundary={type:'Polygon',coordinates:[[[88.5,23.4],[88.5+0.001*scale,23.4],[88.5+0.001*scale,23.4+0.001*scale],[88.5,23.4+0.001*scale],[88.5,23.4]]]};
  const boundaryRequest={requestId:randomUUID(),expectedVersion:1,boundary};
  const plot=await call(agent,`/cases/${id}/boundary`,'PUT',boundaryRequest);assert.ok(Number(plot.areaHectares)<2*scale*scale);
  await call(agent,`/cases/${id}/boundary`,'PUT',boundaryRequest);
  const bytes=await sharp(Buffer.from('<svg width="480" height="320"><rect width="480" height="320" fill="#edf3e6"/><text x="25" y="60" font-size="24" fill="#256348">SYNTHETIC DEMO PROOF</text><rect x="25" y="100" width="240" height="150" fill="#9eb77d"/></svg>')).png().toBuffer();
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const uploads=[];
  for(const slot of ['land_rights','plot_photo']){
    const uploadId=randomUUID(),start={uploadId,slot,mime:'image/png',size:bytes.length,sha256,filename:`synthetic-${slot}.png`};
    const opened=await call(agent,`/cases/${id}/uploads`,'POST',start);assert.equal(opened.chunkSize,262144);
    for(let index=0;index<Math.ceil(bytes.length/262144);index++){
      const chunk={data:bytes.subarray(index*262144,(index+1)*262144).toString('base64')};
      await call(agent,`/uploads/${uploadId}/chunks/${index}`,'PUT',chunk);await call(agent,`/uploads/${uploadId}/chunks/${index}`,'PUT',chunk);
    }
    const resumed=await call(agent,`/cases/${id}/uploads`,'POST',start);assert.ok(resumed.received.length>0);
    assert.equal((await call(agent,`/uploads/${uploadId}/complete`,'POST')).status,'COMPLETE');uploads.push(uploadId);
  }
  const ready=await call(agent,`/cases/${id}`);assert.deepEqual(ready.missing,[]);
  await call(agent,`/cases/${id}/submit`,'POST',{expectedVersion:ready.case.version});
  const submitted=await call(verifier,`/cases/${id}`),decision={decisionId:randomUUID(),expectedVersion:submitted.case.version,decision:'EVIDENCE_APPROVED',reason:'Both synthetic proof images and the boundary have been reviewed.'};
  await call(agent,`/verification/cases/${id}/decision`,'POST',decision,403);
  assert.equal((await call(verifier,`/verification/cases/${id}/decision`,'POST',decision)).state,'EVIDENCE_APPROVED');
  assert.equal((await call(verifier,`/verification/cases/${id}/decision`,'POST',decision)).replayed,true);
  for(const uploadId of uploads){
    const preview=await fetch(`${api}/uploads/${uploadId}/preview`,{headers:verifier});assert.equal(preview.status,200);assert.equal(preview.headers.get('cache-control'),'no-store');assert.ok((await preview.arrayBuffer()).byteLength>100);
    await call({origin},`/uploads/${uploadId}/preview`,'GET',undefined,401);
  }
  const final=await call(agent,`/cases/${id}`);assert.equal(final.case.state,'EVIDENCE_APPROVED');
  assert.equal((await call({origin},'/showcase')).captures.length,3);
  console.log(`Live field smoke passed. Synthetic case: ${id}. Boundary, two proofs, resumable replay, submission, role checks, private previews and immutable review verified.`);
}finally{
  await call(agent,'/session','DELETE',undefined,204);await call(verifier,'/session','DELETE',undefined,204);
}
