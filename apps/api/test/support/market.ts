import {randomUUID} from 'node:crypto';
import type {Database} from '../../src/kernel/database.js';
/** Strings planted in the farmer-facing records; a buyer response that contains either one leaks farmer data. */
export const PII_LABEL='PII-FARMER-LABEL',PII_VILLAGE='PII-VILLAGE-NAME';
export const PRICE=100030n;
/**
 * A market of `groups` farmer cases with `perGroup` available credits each, plus buyers and a price list. Group i became
 * available i days before `asOf` (so the oldest group has waited longest). Direct inserts: the full issuance flow yields one or
 * two credits per case, which is too few for allocation tests.
 */
export async function seedMarket(db:Database,o:{scenario?:string;groups:number;perGroup:number;buyers?:string[];price?:bigint|null;asOf?:Date}){
  const scenario=o.scenario??'market',asOf=o.asOf??new Date(),buyers=o.buyers??['buyer-1','buyer-2'];
  await db.query('INSERT INTO scenarios(id) VALUES ($1) ON CONFLICT DO NOTHING',[scenario]);
  await db.query('INSERT INTO demo_namespaces(scenario_id) VALUES ($1) ON CONFLICT DO NOTHING',[scenario]);
  await db.query(`INSERT INTO users(id,scenario_id,role,password_hash) VALUES ($1,$2,'verifier','x') ON CONFLICT DO NOTHING`,[`${scenario}-verifier`,scenario]);
  for(const b of buyers)await db.query(`INSERT INTO users(id,scenario_id,role,password_hash) VALUES ($1,$2,'buyer','x') ON CONFLICT DO NOTHING`,[b,scenario]);
  if(o.price!==null)await db.query(`INSERT INTO demo_price_list(scenario_id,effective_from,unit_price_paise,created_by) VALUES ($1,$2,$3,'seed')`,[scenario,new Date(asOf.getTime()-400*86_400_000),String(o.price??PRICE)]);
  const groups:{capture:string;batch:string;creditIds:string[]}[]=[];
  for(let g=0;g<o.groups;g++){
    const capture=randomUUID(),decision=randomUUID(),run=randomUUID(),review=randomUUID(),batch=randomUUID(),since=new Date(asOf.getTime()-(g+1)*86_400_000);
    await db.query(`INSERT INTO captures(scenario_id,event_id,actor_id,fingerprint,farmer_label,village,area_hectares) VALUES ($1,$2,'market-agent','f',$3,$4,1.25)`,[scenario,capture,PII_LABEL,PII_VILLAGE]);
    await db.query(`INSERT INTO review_decisions(id,scenario_id,capture_id,reviewer_id,decision,reason,fingerprint,snapshot) VALUES ($1,$2,$3,$4,'EVIDENCE_APPROVED','Synthetic evidence approved','f','{}'::jsonb)`,[decision,scenario,capture,`${scenario}-verifier`]);
    await db.query(`INSERT INTO demo_calculation_runs(id,scenario_id,capture_id,actor_id,evidence_decision_id,methodology_version,parameter_version,preset,inputs_hash,inputs,result,outcome)
      VALUES ($1,$2,$3,'market-agent',$4,'m','p','standard','h','{}'::jsonb,'{}'::jsonb,'CALCULATED')`,[run,scenario,capture,decision]);
    await db.query(`INSERT INTO demo_calculation_reviews(id,scenario_id,capture_id,run_id,reviewer_id,decision,reason,inputs_hash,generation,request_hash)
      VALUES ($1,$2,$3,$4,$5,'APPROVED','Synthetic calculation approved','h',1,'r')`,[review,scenario,capture,run,`${scenario}-verifier`]);
    await db.query(`INSERT INTO demo_issuance_batches(id,scenario_id,capture_id,run_id,review_id,vintage,gross_co2e,buffer_co2e,net_co2e,credit_count,carry_co2e,inputs_hash,created_at)
      VALUES ($1,$2,$3,$4,$5,2026,$6::numeric,0,$6::numeric,$6::integer,0,'h',$7)`,[batch,scenario,capture,run,review,o.perGroup,since]);
    const ids=(await db.query(`INSERT INTO demo_credits(id,batch_id,ordinal,available_since)
      SELECT 'DEMO-2026-'||$1::text||'-'||lpad(n::text,6,'0'),$1::uuid,n,$3 FROM generate_series(1,$2::integer) AS n RETURNING id`,[batch,o.perGroup,since])).rows.map(r=>r.id as string).sort();
    groups.push({capture,batch,creditIds:ids});
  }
  return {scenario,buyers,groups,asOf};
}
export const buyer=(id:string,scenario='market')=>({id,scenarioId:scenario,role:'buyer'});
