import {connectDatabase} from './database.js';
import {auditKeyFromEnvironment} from '../kernel/audit-key.js';
import {verifyAuditFull} from '../modules/audit/application/audit.js';
// Streams and re-verifies the whole audit chain. Slow on large logs, so run it off-peak; the worker also does this on a schedule.
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const database=connectDatabase(process.env.DATABASE_URL,auditKeyFromEnvironment());
try {
  const result=await verifyAuditFull(database.db);
  console.log(JSON.stringify({verified:true,...result}));
} catch (error) {
  console.error(error instanceof Error&&'code' in error?`Audit verification FAILED: ${(error as {code:string}).code}`:'Audit verification could not run');process.exitCode=1;
} finally {await database.close();}
