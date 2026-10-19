// Requires an evidence-approved synthetic case from demo-field-smoke.mjs or the UI.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const api='http://localhost:4000/api/v1',origin='http://localhost:3000';
async function login(account){
  const password=(await readFile(`.local/${account==='presenter'?'presenter':'verifier'}-password.txt`,'utf8')).trim();
  const response=await fetch(api+'/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({account,password})});assert.equal(response.status,200);
  const result=await response.json();return {origin,cookie:response.headers.get('set-cookie').split(';')[0],'x-csrf-token':result.csrf};
}
async function call(headers,path,method='GET',body){
  const response=await fetch(api+path,{method,headers:{...headers,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:response.status===204?{}:await response.json()};
}
const agent=await login('presenter'),verifier=await login('verifier');
try{
  const cases=await call(agent,'/captures');const selected=cases.body.captures.find(row=>row.review_state==='EVIDENCE_APPROVED');assert.ok(selected,'Create/approve a synthetic case before this smoke');
  const id=selected.event_id,detail=await call(agent,`/cases/${id}`),payload={requestId:randomUUID(),expectedVersion:detail.body.case.version,preset:'standard'};
  const calculated=await call(agent,`/cases/${id}/demo-calculations`,'POST',payload);assert.ok([200,201].includes(calculated.status));
  const run=calculated.body.run;assert.equal(run.namespace,'DEMO_ONLY');assert.equal(run.outcome,'CALCULATED');assert.equal(run.result.trace.areaHectares,detail.body.plot.area_hectares);assert.equal(run.inputs_hash.length,64);
  const replay=await call(agent,`/cases/${id}/demo-calculations`,'POST',payload);assert.equal(replay.status,200);assert.equal(replay.body.run.id,run.id);assert.equal(replay.body.replayed,true);
  const conflict=await call(agent,`/cases/${id}/demo-calculations`,'POST',{...payload,preset:'cloudy'});assert.equal(conflict.status,409);
  const view=await call(verifier,`/cases/${id}/demo-calculations`);assert.equal(view.status,200);assert.ok(view.body.runs.some(item=>item.id===run.id));
  const denied=await call(verifier,`/cases/${id}/demo-calculations`,'POST',{...payload,requestId:randomUUID()});assert.equal(denied.status,403);
  console.log(`Live demo calculation passed: ${run.result.grossCo2e} t gross, ${run.result.bufferCo2e} t buffer, ${run.result.netCo2e} t net. Versioned snapshot, replay, changed-key rejection and verifier read-only access verified. No credits issued.`);
}finally{await call(agent,'/session','DELETE');await call(verifier,'/session','DELETE');}
