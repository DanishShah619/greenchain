import {connectDatabase} from './database.js';
import {auditKeyFromEnvironment} from '../kernel/audit-key.js';
import {marketConfig} from './config.js';
import {listFailedPaymentEvents,retryParkedPaymentEvent} from '../modules/market/application/payments.js';
// Operator CLI for payment events whose apply kept failing.
//   payments list            failing and parked events (no bodies)
//   payments retry <eventId> apply a parked event again once its cause is fixed
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const [command,eventId]=process.argv.slice(2);
const config=marketConfig().payments;
const database=connectDatabase(process.env.DATABASE_URL,auditKeyFromEnvironment());
try {
  if(command==='list'){
    console.table(await listFailedPaymentEvents(database.db));
  } else if(command==='retry'&&eventId){
    const result=await retryParkedPaymentEvent(database.db,config.provider,eventId,config);
    console.log(JSON.stringify({status:result.status,outcome:result.outcome??null,code:result.code??null,...(result.error?{cause:result.error}:{})}));
    if(result.status!==200)process.exitCode=1;
  } else {console.error('Usage: payments list | payments retry <eventId>');process.exitCode=2;}
} catch (error) {
  console.error(error instanceof Error&&'code' in error?`Failed: ${(error as {code:string}).code}`:'Failed');process.exitCode=1;
} finally {await database.close();}
