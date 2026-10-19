import {connectDatabase} from './database.js';
import {auditKeyFromEnvironment} from '../kernel/audit-key.js';
import {requeueProof,proofStats} from '../modules/chain/application/worker.js';
// Operator CLI. `proofs list` shows FAILED/RECONCILING proofs; `proofs requeue <eventId> [operator]` retries a FAILED proof that never signed a transaction.
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const [command,eventId,operator]=process.argv.slice(2);
const database=connectDatabase(process.env.DATABASE_URL,auditKeyFromEnvironment());
try {
  if(command==='list'){
    const rows=(await database.db.query(`SELECT event_id,status,failure_count,last_error,transaction_hash IS NOT NULL AS has_transaction,next_attempt_at FROM demo_chain_proofs WHERE status IN ('FAILED','RECONCILING') ORDER BY updated_at DESC LIMIT 100`)).rows;
    console.table(rows);console.log(JSON.stringify((await proofStats(database.db)).byStatus));
  } else if(command==='requeue'&&eventId){
    console.log(JSON.stringify(await requeueProof(database.db,eventId,operator??'operator-cli')));
  } else {console.error('Usage: proofs list | proofs requeue <eventId> [operator]');process.exitCode=2;}
} catch (error) {
  console.error(error instanceof Error&&'code' in error?`Failed: ${(error as {code:string}).code}`:'Failed');process.exitCode=1;
} finally {await database.close();}
