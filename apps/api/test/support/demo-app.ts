import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../../src/bootstrap/app.js';
import {hashPassword} from '../../src/kernel/password.js';
import {seedDemoMarket} from '../../src/modules/market/application/seed.js';
import {DEFAULT_MARKET} from '../../src/modules/market/application/orders.js';
import {DEFAULT_PAYMENTS} from '../../src/modules/market/application/payments.js';
import {migratedPglite} from './pglite.js';
/**
 * The demo as deployed: a presenter scenario seeded like setup.ts (20 groups x 10 credits), its presenter, verifier and buyer
 * accounts, a second agent and buyer, and a presenter account in the public showcase. Sessions are inserted directly so tests
 * can sign in again after a reset revokes them.
 */
export const origin='http://localhost:3000',webhookSecret='test-webhook-secret-of-at-least-32-chars';
export type Headers=Record<string,string>;
export async function demoApp(o:{certificateRatePerMinute?:number}={}){
  const {pg,db}=await migratedPglite();
  for(const s of ['presenter','showcase']){await db.query('INSERT INTO scenarios(id) VALUES ($1)',[s]);await db.query('INSERT INTO demo_namespaces(scenario_id) VALUES ($1)',[s]);}
  for(const [id,scenario,role] of [['presenter','presenter','agent'],['agent-2','presenter','agent'],['verifier','presenter','verifier'],['buyer','presenter','buyer'],
    ['buyer-2','presenter','buyer'],['show-presenter','showcase','agent']])
    await db.query('INSERT INTO users(id,scenario_id,role,password_hash) VALUES ($1,$2,$3,$4)',[id,scenario,role,hashPassword('unused-'+randomUUID())]);
  await db.query("INSERT INTO review_mandates(user_id,scenario_id,institution_id) VALUES ('verifier','presenter','demo-institution')");
  await seedDemoMarket(db,{scenarioId:'presenter'});
  const market={market:DEFAULT_MARKET,payments:{...DEFAULT_PAYMENTS,secrets:[webhookSecret]},demoMode:true,presenterIds:['presenter','show-presenter'],certificateRatePerMinute:o.certificateRatePerMinute};
  const app=await buildApp(db,{origin,secure:false,market});
  async function session(userId:string):Promise<Headers>{
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
    await db.query(`INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`,[createHash('sha256').update(token).digest('hex'),userId,csrf]);
    return {origin,cookie:`session=${token}`,'x-csrf-token':csrf};
  }
  const send=(method:'GET'|'POST'|'PUT',url:string,headers:Headers={},payload?:unknown)=>app.inject({method,url:'/api/v1'+url,headers,...(payload===undefined?{}:{payload:payload as any})});
  /** An order reserved and payment started by a buyer (not yet paid). */
  async function reserve(buyer:Headers,quantity=2){
    const order=(await send('POST','/orders',buyer,{requestId:randomUUID(),quantity})).json();
    assert.equal(order.order.state,'RESERVED',JSON.stringify(order));
    const attempt=(await send('POST',`/orders/${order.order.id}/payment-attempts`,buyer,{acceptSnapshotHash:order.snapshotHash})).json();
    return {orderId:order.order.id as string,providerRef:attempt.providerRef as string};
  }
  /** A paid order: reserved by the buyer, success simulated by the presenter. */
  async function sell(buyer:Headers,presenter:Headers,quantity=2){
    const {orderId}=await reserve(buyer,quantity);
    assert.equal((await send('POST',`/demo/orders/${orderId}/simulate`,presenter,{outcome:'success'})).json().outcome,'FULFILLED');
    return orderId;
  }
  const count=async(sql:string,values:unknown[]=[])=>(await db.query(sql,values)).rows[0].n as number;
  return {db,app,send,session,reserve,sell,count,close:async()=>{await app.close();await pg.close();}};
}
