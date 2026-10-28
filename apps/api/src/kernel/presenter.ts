import type {Database} from './database.js';
import {WorkflowError} from './errors.js';
/**
 * The demo presenter (docs/23 P11): an agent on the allow-list, acting in a demo scenario other than the public showcase,
 * with demo mode on. Shared by every presenter control (the payment simulator and the payout controls), so no ordinary agent
 * can move the clock, simulate payments or cancel payouts.
 */
export type PresenterPolicy={demoMode:boolean;presenterIds:readonly string[];publicScenarioId:string};
export async function requirePresenter(db:Database,actor:{id:string;role:string;scenarioId:string},policy:PresenterPolicy):Promise<void>{
  if(!policy.demoMode||actor.role!=='agent'||!policy.presenterIds.includes(actor.id)||actor.scenarioId===policy.publicScenarioId)throw new WorkflowError('FORBIDDEN',403);
  const namespace=(await db.query('SELECT retired_at FROM demo_namespaces WHERE scenario_id=$1',[actor.scenarioId])).rows[0];
  if(!namespace)throw new WorkflowError('DEMO_SCOPE_ONLY',403);
  if(namespace.retired_at)throw new WorkflowError('SCENARIO_RETIRED',409);
}
/** DEMO_PRESENTER_IDS: comma-separated user ids; defaults to the seeded `presenter` account. */
export function presenterIdsFromEnvironment(raw:string|undefined):string[]{
  const ids=(raw===undefined||raw.trim()===''?'presenter':raw).split(',').map(s=>s.trim()).filter(Boolean);
  for(const id of ids)if(!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id))throw new Error('DEMO_PRESENTER_IDS must be a comma-separated list of user ids');
  return ids;
}
