import {randomUUID} from 'node:crypto';
import {connectDatabase} from './database.js';
import {migrate} from '../kernel/migrate.js';
import {hashPassword} from '../kernel/password.js';
import {seedDemoMarket} from '../modules/market/application/seed.js';
const password=process.env.DEMO_PRESENTER_PASSWORD;
const verifierPassword=process.env.DEMO_VERIFIER_PASSWORD;
if(!password || password.length<16) throw new Error('Set DEMO_PRESENTER_PASSWORD to at least 16 characters');
if(!verifierPassword||verifierPassword.length<16||verifierPassword===password)throw new Error('Set a distinct DEMO_VERIFIER_PASSWORD with at least 16 characters');
const buyerPassword=process.env.DEMO_BUYER_PASSWORD;
if(!buyerPassword||buyerPassword.length<16||buyerPassword===password||buyerPassword===verifierPassword)throw new Error('Set a distinct DEMO_BUYER_PASSWORD with at least 16 characters');
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const database=connectDatabase(process.env.DATABASE_URL);
try {
  const migrated=await migrate(database.db);
  console.log(`Migrations ${migrated.applied.length?`applied: ${migrated.applied.join(', ')}`:'already current'}${migrated.baselined?' (existing database recorded as baseline 0001)':''}; schema version ${migrated.current}.`);
  await database.db.transaction(async tx=>{
    await tx.query("INSERT INTO scenarios(id) VALUES ('showcase'),('presenter') ON CONFLICT DO NOTHING");
    await tx.query("INSERT INTO demo_namespaces(scenario_id) VALUES ('presenter') ON CONFLICT DO NOTHING");
    await tx.query("INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('presenter','presenter','agent',$1) ON CONFLICT DO NOTHING",[hashPassword(password)]);
    await tx.query("INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('verifier','presenter','verifier',$1) ON CONFLICT DO NOTHING",[hashPassword(verifierPassword)]);
    await tx.query("INSERT INTO review_mandates(user_id,scenario_id,institution_id) VALUES ('verifier','presenter','demo-institution') ON CONFLICT DO NOTHING");
    await tx.query("INSERT INTO users(id,scenario_id,role,password_hash) VALUES ('buyer','presenter','buyer',$1) ON CONFLICT DO NOTHING",[hashPassword(buyerPassword)]);
    const fixtures=[['Demo farmer 01','Nadia','1.25'],['Demo farmer 02','Birbhum','0.80'],['Demo farmer 03','Murshidabad','2.10']];
    for(let i=0;i<fixtures.length;i++) await tx.query(`INSERT INTO captures(scenario_id,event_id,actor_id,fingerprint,farmer_label,village,area_hectares)
      VALUES ('showcase',$1,'seed','fixture',$2,$3,$4) ON CONFLICT DO NOTHING`,[`00000000-0000-4000-8000-00000000000${i+1}`,...fixtures[i]]);
  });
  const seeded=await seedDemoMarket(database.db,{scenarioId:'presenter'});
  console.log(`Demo market: ${seeded.groupsCreated?`seeded ${seeded.groupsCreated} synthetic farmer groups`:'already seeded'}.`);
  console.log('Schema and synthetic showcase ready. Existing presenter, verifier and buyer passwords preserved.');
} finally {await database.close();}
