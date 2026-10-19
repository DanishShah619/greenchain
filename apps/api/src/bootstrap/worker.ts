import {connectDatabase} from './database.js';
import {auditKeyFromEnvironment} from '../kernel/audit-key.js';
import {runChainCycle} from '../modules/chain/application/worker.js';
import {amoyFromEnvironment} from '../modules/chain/infrastructure/evm.js';
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const database=connectDatabase(process.env.DATABASE_URL,auditKeyFromEnvironment()),chain=await amoyFromEnvironment();
let stopped=false;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{stopped=true;});
try {
  while(!stopped) {
    await runChainCycle(database.db,chain);
    const result=await database.db.transaction(async tx=>{
      const job=(await tx.query('SELECT id FROM jobs WHERE processed_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1')).rows[0];
      if(!job) return false;
      // Foundation consumer only: delivery receipt, no MRV or verification claim.
      await tx.query('UPDATE jobs SET processed_at=now() WHERE id=$1',[job.id]);
      return true;
    });
    if(!result) await new Promise(resolve=>setTimeout(resolve,1000));
  }
} finally {chain?.close();await database.close();}
