// Development-only fallback when Docker is unavailable. Never use this for hosting.
import {PGlite} from '@electric-sql/pglite';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {buildApp} from '../src/bootstrap/app.js';
import {migrate} from '../src/kernel/migrate.js';
import {hashPassword} from '../src/kernel/password.js';
import type {Database} from '../src/kernel/database.js';
import {runChainCycle} from '../src/modules/chain/application/worker.js';
import {amoyFromEnvironment} from '../src/modules/chain/infrastructure/evm.js';
import {SHOWCASE_MARKET,seedDemoMarket} from '../src/modules/market/application/seed.js';
import {DEFAULT_MARKET} from '../src/modules/market/application/orders.js';
import {DEFAULT_PAYMENTS} from '../src/modules/market/application/payments.js';
import {DEFAULT_SWEEP,marketSweep,newSweepState} from '../src/modules/market/application/sweep.js';
const sweepState=newSweepState();
const folder=resolve('../../.local');
await mkdir(folder,{recursive:true});
const auditPath=resolve(folder,'audit-hmac-key.txt');
let auditKey:Buffer;
try{auditKey=Buffer.from((await readFile(auditPath,'utf8')).trim(),'base64url');}
catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;auditKey=randomBytes(32);await writeFile(auditPath,auditKey.toString('base64url')+'\n',{flag:'wx'});}
if(auditKey.length!==32)throw new Error('Invalid local audit key');
const passwordPath=resolve(folder,'presenter-password.txt');
let password:string;
try {password=(await readFile(passwordPath,'utf8')).trim();}
catch(error) {
  if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
  password=randomBytes(24).toString('base64url');
  await writeFile(passwordPath,password+'\n',{flag:'wx'});
}
const pg=new PGlite(resolve(folder,'demo-postgres'));
const verifierPath=resolve(folder,'verifier-password.txt');
let verifierPassword:string;
try{verifierPassword=(await readFile(verifierPath,'utf8')).trim();}
catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;verifierPassword=randomBytes(24).toString('base64url');await writeFile(verifierPath,verifierPassword+'\n',{flag:'wx'});}
/** Reads a generated local secret, creating it once. These files live in .local/, which is excluded from source control. */
async function localSecret(name:string){
  const path=resolve(folder,name);
  try{return {path,value:(await readFile(path,'utf8')).trim()};}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const value=randomBytes(24).toString('base64url');await writeFile(path,value+'\n',{flag:'wx'});return {path,value};}
}
const buyer=await localSecret('buyer-password.txt'),webhook=await localSecret('payment-webhook-secret.txt');
const wrap=(client:{query:Function;exec:Function}):Database=>({
  auditKey,
  query:async(sql,values)=>(await client.query(sql,values)) as any,
  exec:async sql=>{await client.exec(sql);},
  transaction:async work=>pg.transaction(async tx=>work(wrap(tx)))
});
const db=wrap(pg);
await migrate(db);
await db.transaction(async tx=>{
  await tx.query("INSERT INTO scenarios(id) VALUES ('showcase'),('presenter') ON CONFLICT DO NOTHING");
  await tx.query("INSERT INTO demo_namespaces(scenario_id) VALUES ('presenter'),('showcase') ON CONFLICT DO NOTHING");
  await tx.query("INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('presenter','presenter','agent',$1) ON CONFLICT DO NOTHING",[hashPassword(password)]);
  await tx.query("INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('verifier','presenter','verifier',$1) ON CONFLICT DO NOTHING",[hashPassword(verifierPassword)]);
  await tx.query("INSERT INTO review_mandates(user_id,scenario_id,institution_id) VALUES ('verifier','presenter','demo-institution') ON CONFLICT DO NOTHING");
  await tx.query("INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('buyer','presenter','buyer',$1) ON CONFLICT DO NOTHING",[hashPassword(buyer.value)]);
  const fixtures=[['Demo farmer 01','Nadia','1.25'],['Demo farmer 02','Birbhum','0.80'],['Demo farmer 03','Murshidabad','2.10']];
  for(let i=0;i<fixtures.length;i++) await tx.query(`INSERT INTO captures(scenario_id,event_id,actor_id,fingerprint,farmer_label,village,area_hectares)
    VALUES ('showcase',$1,'seed','fixture',$2,$3,$4) ON CONFLICT DO NOTHING`,[`00000000-0000-4000-8000-00000000000${i+1}`,...fixtures[i]]);
});
await seedDemoMarket(db,{scenarioId:'presenter'});
await seedDemoMarket(db,SHOWCASE_MARKET);
// The local demo always runs the simulated provider with presenter controls (DEMO_MODE). Hosting configures these explicitly.
const app=await buildApp(db,{origin:'http://localhost:3000',secure:false,market:{market:DEFAULT_MARKET,payments:{...DEFAULT_PAYMENTS,secrets:[webhook.value.padEnd(32,'.')]},demoMode:true}});
const chain=await amoyFromEnvironment();
let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,inFlight:Promise<void>=Promise.resolve();
async function cycle(){try{const result=await runChainCycle(db,chain);if('error' in result)app.log.warn({code:result.error},'Chain proof pending');}catch{app.log.error('Audit worker failed; proof submission halted');}
  try{const swept=await marketSweep(db,{config:DEFAULT_SWEEP,state:sweepState});if(swept.violations?.length)app.log.error({codes:[...new Set(swept.violations.map(v=>v.code))]},'Market invariant violated');}catch{app.log.error('Market sweep failed');}finally{if(!stopped)timer=setTimeout(()=>{inFlight=cycle();},2000);}}
inFlight=cycle();
app.addHook('onClose',async()=>{stopped=true;clearTimeout(timer);await inFlight;chain?.close();await pg.close();});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>void app.close());
await app.listen({host:'127.0.0.1',port:4000});
console.log(`Embedded PostgreSQL demo ready. Credentials: ${passwordPath}, ${verifierPath} and ${buyer.path}. Demo market seeded; simulated payments on. Audit/proof worker active; Amoy ${chain?'configured':'not configured'}.`);
