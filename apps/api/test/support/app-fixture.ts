import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {buildApp} from '../../src/bootstrap/app.js';
import {migratedPglite} from './pglite.js';
import {hashPassword} from '../../src/kernel/password.js';
import type {Database} from '../../src/kernel/database.js';
export const origin='http://localhost:3000',password='test-password-for-demo-123';
/**
 * A fully wired app over a migrated database with a presenter agent, a verifier with a review mandate, and helpers that walk a
 * case through capture, evidence and calculation. Pass an existing database (for example real PostgreSQL) or get an in-process one.
 */
export async function fixture(database?:{db:Database;close():Promise<void>}){
  const {db,close:closeDatabase}=database??await (async()=>{const {pg,db}=await migratedPglite();return {db,close:async()=>{await pg.close();}};})();
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
  return {db,app,send,create,upload,complete,ready,agent,verifier,close:async()=>{await app.close();await closeDatabase();}};
}
