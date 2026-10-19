import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {migratedPglite} from './support/pglite.js';
import {hashPassword} from '../src/kernel/password.js';
import {buildApp} from '../src/bootstrap/app.js';
import {capture} from '../src/modules/capture/application/capture.js';
import type {Database} from '../src/kernel/database.js';
const origin='http://localhost:3000',password='test-only-password-12345';
async function fixture(){
  const {pg,db}=await migratedPglite();
  await db.query("INSERT INTO scenarios VALUES ('presenter'),('showcase'),('other')");
  await db.query("INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('presenter','presenter','agent',$1)",[hashPassword(password)]);
  const app=await buildApp(db,{origin,secure:false});
  async function login(){
    const result=await app.inject({method:'POST',url:'/api/v1/session',headers:{origin},payload:{password}});
    assert.equal(result.statusCode,200);
    return {origin,cookie:result.cookies[0].name+'='+result.cookies[0].value,'x-csrf-token':result.json().csrf};
  }
  return {db,app,login,close:async()=>{await app.close();await pg.close();}};
}
const input=()=>({eventId:randomUUID(),farmerLabel:'Demo farmer',village:'Nadia',areaHectares:'1.25',consent:true as const});
const onboarding=()=>({version:1,language:'bn',district:'Nadia',plotLabel:'Demo plot A',landRight:'consented_cultivator',crop:'Demo rice',season:'kharif',consentVersion:'demo-consent-v1',purpose:'demo-onboarding'});
test('onboarding details persist, canonical replay succeeds and changed consent fails',async()=>{
  const f=await fixture();
  try{
    const headers=await f.login(),payload={...input(),onboarding:onboarding()};
    const send=(body:any)=>f.app.inject({method:'POST',url:'/api/v1/captures',headers,payload:body});
    assert.equal((await send(payload)).statusCode,201);
    const reversed=Object.fromEntries(Object.entries(payload.onboarding).reverse());
    assert.equal((await send({...payload,onboarding:reversed})).statusCode,200);
    assert.equal((await send({...payload,onboarding:{...payload.onboarding,language:'hi'}})).statusCode,409);
    const list=(await f.app.inject({url:'/api/v1/captures',headers})).json().captures;
    assert.deepEqual(list[0].onboarding,payload.onboarding);
    assert.equal((await send({...input(),onboarding:{...onboarding(),consentVersion:'unknown'}})).statusCode,400);
    assert.equal((await send({...input(),onboarding:{...onboarding(),verified:true}})).statusCode,400);
    assert.equal((await send({...input(),onboarding:{...onboarding(),district:'  '}})).statusCode,400);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM captures')).rows[0].n,1);
  }finally{await f.close();}
});
test('HTTP capture commits once, rejects changed replay and retains one audit/job',async()=>{
  const f=await fixture();
  try{
    const headers=await f.login(),payload=input();
    const send=(body=payload)=>f.app.inject({method:'POST',url:'/api/v1/captures',headers,payload:body});
    assert.equal((await send()).statusCode,201);
    const replay=await send();assert.equal(replay.statusCode,200);assert.equal(replay.json().replayed,true);
    const changed=await send({...payload,village:'Different'});assert.equal(changed.statusCode,409);assert.equal(changed.json().code,'KEY_REUSE');
    for(const table of ['captures','audit_events','jobs']) assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,1);
    assert.equal((await f.app.inject({url:'/api/v1/showcase'})).json().captures.length,0);
    assert.equal((await f.app.inject({url:'/api/v1/captures',headers})).json().captures.length,1);
  }finally{await f.close();}
});
test('public writes, forged roles, missing CSRF and untrusted origins fail',async()=>{
  const f=await fixture();
  try{
    const headers=await f.login();
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/captures',headers:{origin},payload:input()})).statusCode,401);
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/captures',headers:{origin,cookie:headers.cookie},payload:input()})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/captures',headers:{...headers,origin:'https://untrusted.test'},payload:input()})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/captures',headers,payload:{...input(),role:'agent',scenarioId:'showcase'}})).statusCode,400);
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/captures',headers,payload:{...input(),consent:false}})).statusCode,400);
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/captures',headers,payload:{...input(),areaHectares:'0.00'}})).statusCode,400);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM captures')).rows[0].n,0);
  }finally{await f.close();}
});
test('expired and signed-out sessions cannot read or mutate private captures',async()=>{
  const f=await fixture();
  try{
    const headers=await f.login();
    assert.equal((await f.app.inject({method:'DELETE',url:'/api/v1/session',headers})).statusCode,204);
    assert.equal((await f.app.inject({url:'/api/v1/captures',headers})).statusCode,401);
    const expired=await f.login();await f.db.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/captures',headers:expired,payload:input()})).statusCode,401);
  }finally{await f.close();}
});
test('capture rolls back if durable job insertion fails',async()=>{
  const f=await fixture();
  try{
    await f.db.query('DROP TABLE jobs');
    await assert.rejects(()=>capture(f.db,{id:'presenter',scenarioId:'presenter',role:'agent'},input()));
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM captures')).rows[0].n,0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n,0);
  }finally{await f.close();}
});
test('event IDs are scoped and a different actor cannot replay an existing capture',async()=>{
  const f=await fixture();
  try{
    const payload=input();
    await capture(f.db,{id:'presenter',scenarioId:'presenter',role:'agent'},payload);
    await capture(f.db,{id:'other',scenarioId:'other',role:'agent'},payload);
    await assert.rejects(()=>capture(f.db,{id:'imposter',scenarioId:'presenter',role:'agent'},payload));
    const headers=await f.login();
    const captures=(await f.app.inject({url:'/api/v1/captures',headers})).json().captures;
    assert.equal(captures.length,1);
  }finally{await f.close();}
});
test('framework client errors keep their 4xx status and are not retryable',async()=>{
  const f=await fixture();
  try{
    const headers={origin,'content-type':'application/json'};
    const large=await f.app.inject({method:'POST',url:'/api/v1/session',headers,payload:JSON.stringify({password:'x'.repeat(20000)})});
    assert.equal(large.statusCode,413);
    assert.deepEqual([large.json().code,large.json().retryable],['PAYLOAD_TOO_LARGE',false]);
    const malformed=await f.app.inject({method:'POST',url:'/api/v1/session',headers,payload:'{not json'});
    assert.equal(malformed.statusCode,400);
    assert.equal(malformed.json().retryable,false);
  }finally{await f.close();}
});
test('a successful login clears failed attempts and only failures count towards the limit',async()=>{
  const f=await fixture();
  const attempt=(pw:string)=>f.app.inject({method:'POST',url:'/api/v1/session',headers:{origin},payload:{password:pw}});
  try{
    for(let i=0;i<9;i++) assert.equal((await attempt('wrong')).statusCode,401);
    assert.equal((await attempt(password)).statusCode,200);
    // The counter was cleared, so nine more failures are still answered with 401 rather than 429.
    for(let i=0;i<9;i++) assert.equal((await attempt('wrong')).statusCode,401);
    assert.equal((await attempt(password)).statusCode,200);
    // Repeated successful logins never trigger the limiter on their own.
    for(let i=0;i<12;i++) assert.equal((await attempt(password)).statusCode,200);
  }finally{await f.close();}
});
test('login limiter ignores forwarded addresses unless proxy hops are trusted, and then separates clients',async()=>{
  const f=await fixture();
  const attempt=(app:typeof f.app,pw:string,forwarded:string)=>app.inject({method:'POST',url:'/api/v1/session',remoteAddress:'10.0.0.1',headers:{origin,'x-forwarded-for':forwarded},payload:{password:pw}});
  try{
    // Default: X-Forwarded-For is untrusted, so rotating it cannot evade the limit.
    for(let i=0;i<10;i++) assert.equal((await attempt(f.app,'wrong',`198.51.100.${i+1}`)).statusCode,401);
    assert.equal((await attempt(f.app,password,'203.0.113.200')).statusCode,429);
    await f.db.query('DELETE FROM login_attempts');
    // One trusted hop: each real client has its own counter.
    const proxied=await buildApp(f.db,{origin,secure:false,trustProxy:1});
    try{
      for(let i=0;i<10;i++) assert.equal((await attempt(proxied,'wrong','203.0.113.5')).statusCode,401);
      assert.equal((await attempt(proxied,password,'203.0.113.5')).statusCode,429);
      assert.equal((await attempt(proxied,password,'203.0.113.6')).statusCode,200);
    }finally{await proxied.close();}
  }finally{await f.close();}
});
test('readiness reflects DB failure and login attempts are bounded',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.app.inject({url:'/api/v1/health'})).statusCode,200);
    for(let i=0;i<10;i++) assert.equal((await f.app.inject({method:'POST',url:'/api/v1/session',headers:{origin},payload:{password:'wrong'}})).statusCode,401);
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/session',headers:{origin},payload:{password}})).statusCode,429);
  }finally{await f.close();}
  const broken:Database={query:async()=>{throw new Error('offline');},transaction:async()=>{throw new Error('offline');}};
  const app=await buildApp(broken,{origin,secure:false});
  try{assert.equal((await app.inject({url:'/api/v1/health'})).statusCode,503);}finally{await app.close();}
});
