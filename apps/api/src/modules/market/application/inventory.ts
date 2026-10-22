import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
import type {Actor} from '../../capture/application/capture.js';
import {DEMO_LABEL,groupLabel,requireBuyer} from './orders.js';
const priceNow=async(db:Database,scenarioId:string)=>(await db.query(`SELECT unit_price_paise,effective_from FROM demo_price_list WHERE scenario_id=$1 AND effective_from<=now() ORDER BY effective_from DESC LIMIT 1`,[scenarioId])).rows[0];
/**
 * GET /market/inventory: what a buyer can see before ordering. A read without the scenario lock, so it is a snapshot ("as of").
 * Per group only a pseudonymous label, counts, vintage and provenance ids (batch and calculation). No names, villages or areas.
 */
export async function inventory(db:Database,actor:Actor){
  requireBuyer(actor);
  const price=await priceNow(db,actor.scenarioId);
  if(!(await db.query('SELECT 1 FROM demo_namespaces WHERE scenario_id=$1',[actor.scenarioId])).rows.length)throw new WorkflowError('DEMO_SCOPE_ONLY',403);
  const rows=(await db.query(`SELECT b.capture_id,b.id AS batch_id,b.run_id,b.vintage,
      count(*) FILTER (WHERE c.state='AVAILABLE')::int AS available,count(*) FILTER (WHERE c.state='RESERVED')::int AS reserved,count(*) FILTER (WHERE c.state='SOLD')::int AS sold
    FROM demo_issuance_batches b JOIN demo_credits c ON c.batch_id=b.id WHERE b.scenario_id=$1 GROUP BY b.capture_id,b.id,b.run_id,b.vintage`,[actor.scenarioId])).rows;
  const groups=rows.map(r=>({group:groupLabel(r.capture_id),vintage:r.vintage as number,available:r.available as number,reserved:r.reserved as number,sold:r.sold as number,
    provenance:{batchId:r.batch_id as string,calculationId:r.run_id as string}})).sort((a,b)=>b.available-a.available||(a.group<b.group?-1:1));
  return {namespace:'DEMO_ONLY' as const,label:DEMO_LABEL,asOf:new Date().toISOString(),
    currency:'INR' as const,unitPricePaise:price?String(price.unit_price_paise):null,priceEffectiveFrom:price?new Date(price.effective_from).toISOString():null,
    available:groups.reduce((n,g)=>n+g.available,0),groups};
}
/**
 * The public showcase's sample market (docs/22 §3): read-only totals for the showcase scenario's own seeded credits. No groups,
 * ids or provenance, and nothing a visitor can change. All zeros until setup seeds it.
 */
export async function showcaseMarket(db:Database,scenarioId:string){
  const price=await priceNow(db,scenarioId);
  const row=(await db.query(`SELECT count(DISTINCT b.capture_id)::int AS groups,count(*) FILTER (WHERE c.state='AVAILABLE')::int AS available,
      count(*) FILTER (WHERE c.state='RESERVED')::int AS reserved,count(*) FILTER (WHERE c.state='SOLD')::int AS sold
    FROM demo_issuance_batches b JOIN demo_credits c ON c.batch_id=b.id WHERE b.scenario_id=$1`,[scenarioId])).rows[0];
  return {namespace:'DEMO_ONLY' as const,label:DEMO_LABEL,currency:'INR' as const,unitPricePaise:price?String(price.unit_price_paise):null,
    groups:row.groups as number,available:row.available as number,reserved:row.reserved as number,sold:row.sold as number};
}
