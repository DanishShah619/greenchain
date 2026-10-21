import {createHash,randomBytes} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {hashPassword} from '../../../kernel/password.js';
/**
 * The demo market (docs/22 §13 Q2, docs/13 "Seed and presentation scenarios"): 20 synthetic farmer groups with 10 available
 * demo credits each, and a flat demo price. Written directly because the real issuance path yields one or two credits per case.
 * Idempotent: every id is derived from the scenario and position, and every insert is ON CONFLICT DO NOTHING, so running setup
 * again changes nothing (including credits that have since been reserved or sold).
 */
export const DEMO_PRICE_PAISE=100030n;
const uuidFrom=(name:string)=>{
  const h=createHash('sha256').update(`greenchain-demo-market:${name}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
};
export async function seedDemoMarket(db:Database,o:{scenarioId:string;groups?:number;perGroup?:number;pricePaise?:bigint;now?:Date}){
  const groups=o.groups??20,perGroup=o.perGroup??10,now=o.now??new Date(),scenario=o.scenarioId,reviewer=`${scenario}-market-reviewer`;
  return db.transaction(async tx=>{
    // A reviewer row exists only to satisfy foreign keys; its password is random and never stored anywhere.
    await tx.query(`INSERT INTO users(id,scenario_id,role,password_hash) VALUES ($1,$2,'verifier',$3) ON CONFLICT DO NOTHING`,[reviewer,scenario,hashPassword(randomBytes(32).toString('hex'))]);
    await tx.query(`INSERT INTO demo_price_list(scenario_id,effective_from,unit_price_paise,created_by) VALUES ($1,'2026-01-01T00:00:00Z',$2,'seed') ON CONFLICT DO NOTHING`,[scenario,String(o.pricePaise??DEMO_PRICE_PAISE)]);
    let created=0;
    for(let g=0;g<groups;g++){
      const key=`${scenario}:${g}`,capture=uuidFrom(`${key}:capture`),decision=uuidFrom(`${key}:decision`),run=uuidFrom(`${key}:run`),review=uuidFrom(`${key}:review`),batch=uuidFrom(`${key}:batch`);
      const since=new Date(now.getTime()-(g+1)*86_400_000),label=`Market seed farmer ${String(g+1).padStart(2,'0')}`;
      const inserted=(await tx.query(`INSERT INTO captures(scenario_id,event_id,actor_id,fingerprint,farmer_label,village,area_hectares) VALUES ($1,$2,'market-seed','seed',$3,'Synthetic village',1.00) ON CONFLICT DO NOTHING RETURNING event_id`,[scenario,capture,label])).rows.length;
      if(!inserted)continue;
      created++;
      await tx.query(`INSERT INTO review_decisions(id,scenario_id,capture_id,reviewer_id,decision,reason,fingerprint,snapshot) VALUES ($1,$2,$3,$4,'EVIDENCE_APPROVED','Synthetic seed evidence','seed','{}'::jsonb)`,[decision,scenario,capture,reviewer]);
      await tx.query(`INSERT INTO demo_calculation_runs(id,scenario_id,capture_id,actor_id,evidence_decision_id,methodology_version,parameter_version,preset,inputs_hash,inputs,result,outcome)
        VALUES ($1,$2,$3,'market-seed',$4,'demo-seed','demo-seed','standard','seed','{}'::jsonb,'{}'::jsonb,'CALCULATED')`,[run,scenario,capture,decision]);
      await tx.query(`INSERT INTO demo_calculation_reviews(id,scenario_id,capture_id,run_id,reviewer_id,decision,reason,inputs_hash,generation,request_hash)
        VALUES ($1,$2,$3,$4,$5,'APPROVED','Synthetic seed calculation','seed',1,'seed')`,[review,scenario,capture,run,reviewer]);
      await tx.query(`INSERT INTO demo_issuance_batches(id,scenario_id,capture_id,run_id,review_id,vintage,gross_co2e,buffer_co2e,net_co2e,credit_count,carry_co2e,inputs_hash,created_at)
        VALUES ($1,$2,$3,$4,$5,2026,$6::numeric,0,$6::numeric,$6::integer,0,'seed',$7)`,[batch,scenario,capture,run,review,perGroup,since]);
      await tx.query(`INSERT INTO demo_credits(id,batch_id,ordinal,available_since) SELECT 'DEMO-2026-'||$1::text||'-'||lpad(n::text,6,'0'),$1::uuid,n,$3 FROM generate_series(1,$2::integer) AS n`,[batch,perGroup,since]);
    }
    return {groupsCreated:created};
  });
}
