// Builds a fresh synthetic source case, then reviews/ issues its exact saved calculation.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
process.env.DEMO_BOUNDARY_SCALE='2';
const {lastCaseId:id}=await import('./demo-field-smoke.mjs');
const api='http://localhost:4000/api/v1',origin='http://localhost:3000';
async function login(account){
  const password=(await readFile(`.local/${account==='presenter'?'presenter':'verifier'}-password.txt`,'utf8')).trim();
  const response=await fetch(api+'/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({account,password})});assert.equal(response.status,200);
  const session=await response.json();return {origin,cookie:response.headers.get('set-cookie').split(';')[0],'x-csrf-token':session.csrf};
}
async function call(headers,path,method='GET',body,expected=200){
  const response=await fetch(api+path,{method,headers:{...headers,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const data=response.status===204?{}:await response.json();assert.equal(response.status,expected,`${path}: ${data.code??''}`);return data;
}
const agent=await login('presenter'),verifier=await login('verifier');
try{
  const detail=await call(agent,`/cases/${id}`);
  const calc=await call(agent,`/cases/${id}/demo-calculations`,'POST',{requestId:randomUUID(),expectedVersion:detail.case.version,preset:'standard'},201);
  const history=await call(verifier,`/cases/${id}/demo-calculations`),payload={decisionId:randomUUID(),expectedGeneration:history.selection.generation,inputsHash:calc.run.inputs_hash,decision:'APPROVED',reason:'Synthetic calculation, evidence linkage and buffer have been independently checked.'};
  await call(agent,`/cases/${id}/demo-calculations/${calc.run.id}/review`,'POST',payload,403);
  const approved=await call(verifier,`/cases/${id}/demo-calculations/${calc.run.id}/review`,'POST',payload);assert.equal(approved.issuance.credit_count,2);
  const replay=await call(verifier,`/cases/${id}/demo-calculations/${calc.run.id}/review`,'POST',payload);assert.equal(replay.replayed,true);
  const inventory=await call(agent,`/cases/${id}/demo-issuance`);assert.equal(inventory.credits.length,2);assert.equal(inventory.batch.run_id,calc.run.id);assert.equal(inventory.batch.review_id,approved.review.id);assert.equal(inventory.proofStatus,'NOT_CONFIGURED');
  assert.equal(new Set(inventory.credits.map(credit=>credit.id)).size,2);assert.ok(inventory.credits.every(credit=>credit.state==='AVAILABLE'));
  const units=value=>BigInt(value.replace('.',''));
  assert.equal(units(inventory.batch.gross_co2e),units(inventory.batch.buffer_co2e)+BigInt(inventory.batch.credit_count)*10000n+units(inventory.batch.carry_co2e));
  await call(verifier,`/cases/${id}/demo-calculations/${calc.run.id}/review`,'POST',{...payload,decisionId:randomUUID()},409);
  console.log(`Live issuance passed: ${inventory.batch.credit_count} unique demo credits; ${inventory.batch.buffer_co2e} t buffer; ${inventory.batch.carry_co2e} t carry-over. One reviewed basis, duplicate prevention and provenance verified. Blockchain proof remains pending.`);
}finally{await call(agent,'/session','DELETE',undefined,204);await call(verifier,'/session','DELETE',undefined,204);}
