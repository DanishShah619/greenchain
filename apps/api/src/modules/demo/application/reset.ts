import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
import {appendAudit} from '../../audit/application/audit.js';
import type {Actor} from '../../capture/application/capture.js';
import {marketReviewerId,seedDemoMarketTx,type MarketSeed} from '../../market/application/seed.js';
/**
 * Safe presenter reset (docs/24 R1-R6): rotation, never deletion. The audit chain is global and the ledger, journals, payouts
 * and rail are append-only, so the presenter's scenario is not emptied: its accounts move to a fresh scenario seeded to the
 * documented starting state, the old scenario is retired and kept as it was, and every session of the moved accounts is
 * revoked. One transaction: a failure anywhere (including the seed) leaves everything as it was.
 *
 * Lock order: a global advisory lock (scenario creation and request replay), then the old scenario's row (lock order step 1).
 */
export type ResetDeps={seed:(tx:Database,o:MarketSeed)=>Promise<unknown>};
export type ResetResult={namespace:'DEMO_ONLY';scenarioId:string;replayed:boolean;signInAgain:true};
const RESET_LOCK="SELECT pg_advisory_xact_lock(hashtextextended('greenchain:scenario-reset',0))";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** presenter, presenter-r2, presenter-r3, ...: the base id stays recognisable across rotations. */
export const baseScenario=(scenarioId:string)=>scenarioId.replace(/-r[0-9]+$/,'');
export async function resetPresenterScenario(db:Database,actor:Actor,input:{requestId:string;confirm:string},deps:ResetDeps={seed:seedDemoMarketTx}):Promise<ResetResult>{
  if(input.confirm!=='RESET'||typeof input.requestId!=='string'||!UUID.test(input.requestId))throw new WorkflowError('VALIDATION_FAILED',422);
  return db.transaction(async tx=>{
    await tx.query(RESET_LOCK);
    const prior=(await tx.query('SELECT to_scenario FROM demo_scenario_resets WHERE request_id=$1',[input.requestId])).rows[0];
    if(prior)return {namespace:'DEMO_ONLY',scenarioId:prior.to_scenario as string,replayed:true,signInAgain:true};
    const old=actor.scenarioId;
    const row=(await tx.query(`SELECT n.retired_at FROM scenarios s JOIN demo_namespaces n ON n.scenario_id=s.id WHERE s.id=$1 FOR UPDATE OF s`,[old])).rows[0];
    if(!row)throw new WorkflowError('DEMO_SCOPE_ONLY',403);
    if(row.retired_at)throw new WorkflowError('SCENARIO_RETIRED',409);
    const base=baseScenario(old);
    const taken=(await tx.query(`SELECT id FROM scenarios WHERE id=$1 OR id ~ ('^'||$2||'-r[0-9]+$')`,[base,base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')])).rows.map(r=>r.id as string);
    const next=`${base}-r${Math.max(1,...taken.map(id=>Number(/-r([0-9]+)$/.exec(id)?.[1]??1)))+1}`;
    await tx.query('INSERT INTO scenarios(id) VALUES ($1)',[next]);
    await tx.query('INSERT INTO demo_namespaces(scenario_id) VALUES ($1)',[next]);
    // Every person-facing account of the scenario moves; the seed's reviewer account stays with the reviews it signed.
    const moved=(await tx.query('UPDATE users SET scenario_id=$2 WHERE scenario_id=$1 AND id<>$3 RETURNING id',[old,next,marketReviewerId(old)])).rows.map(r=>r.id as string);
    await tx.query(`INSERT INTO review_mandates(user_id,scenario_id,institution_id) SELECT user_id,$2,institution_id FROM review_mandates WHERE scenario_id=$1 AND user_id=ANY($3::text[])`,[old,next,moved]);
    await tx.query('DELETE FROM sessions WHERE user_id=ANY($1::text[])',[moved]);
    await tx.query('UPDATE demo_namespaces SET retired_at=now() WHERE scenario_id=$1',[old]);
    await deps.seed(tx,{scenarioId:next});
    const anchor=(await tx.query('SELECT event_id::text AS id FROM captures WHERE scenario_id=$1 ORDER BY created_at,event_id LIMIT 1',[old])).rows[0]?.id as string|undefined;
    if(!anchor)throw new WorkflowError('SCENARIO_EMPTY',409);
    await appendAudit(tx,actor,anchor,'demo.scenario.reset',{from:old,to:next,requestId:input.requestId,accountsMoved:moved.length});
    await tx.query('INSERT INTO demo_scenario_resets(request_id,actor_id,from_scenario,to_scenario) VALUES ($1,$2,$3,$4)',[input.requestId,actor.id,old,next]);
    return {namespace:'DEMO_ONLY',scenarioId:next,replayed:false,signInAgain:true};
  });
}
