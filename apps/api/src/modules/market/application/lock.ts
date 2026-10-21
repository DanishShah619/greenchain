import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
/**
 * The one way into market state (docs/22 B5). Every market write runs inside this: it takes the scenario row lock first, then
 * reads the clock once. Callers then lock order rows (ascending id), payment attempts, and credit rows (ascending id), in
 * that order. Do not take FOR UPDATE on market tables anywhere else.
 *
 * `asOf` is clock_timestamp() read AFTER the lock is held: now() is the transaction start, which is stale after a lock wait.
 */
type LockObserver=(waitSeconds:number)=>void;
let observer:LockObserver|undefined;
/** Lets a process record how long market writers wait for the scenario lock (a contention signal). One observer per process. */
export function observeScenarioLockWait(fn:LockObserver|undefined){observer=fn;}
export async function withScenarioLock<T>(db:Database,scenarioId:string,work:(tx:Database,asOf:Date)=>Promise<T>):Promise<T>{
  return db.transaction(async tx=>{
    const started=performance.now();
    const row=(await tx.query(`SELECT s.id,n.scenario_id AS demo FROM scenarios s LEFT JOIN demo_namespaces n ON n.scenario_id=s.id WHERE s.id=$1 FOR UPDATE OF s`,[scenarioId])).rows[0];
    observer?.((performance.now()-started)/1000);
    if(!row)throw new WorkflowError('NOT_FOUND',404);
    if(!row.demo)throw new WorkflowError('DEMO_SCOPE_ONLY',403);
    const asOf=new Date((await tx.query('SELECT clock_timestamp() AS t')).rows[0].t);
    return work(tx,asOf);
  });
}
