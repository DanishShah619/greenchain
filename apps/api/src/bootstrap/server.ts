import {connectDatabase} from './database.js';
import {buildApp} from './app.js';
import {config} from './config.js';
import {auditKeyFromEnvironment} from '../kernel/audit-key.js';
import {Metrics} from '../kernel/metrics.js';
import {declareMarketApiMetrics} from '../modules/market/application/metrics.js';
import {observeScenarioLockWait} from '../modules/market/application/lock.js';
import {startOpsServer} from './ops-server.js';
const settings=config(),database=connectDatabase(settings.url,auditKeyFromEnvironment());
const metrics=new Metrics();declareMarketApiMetrics(metrics);
observeScenarioLockWait(seconds=>{metrics.inc('greenchain_scenario_lock_wait_seconds_total',{},seconds);metrics.inc('greenchain_scenario_lock_acquisitions_total');});
const app=await buildApp(database.db,{...settings,market:{...settings.market,metrics}});
// API metrics on a separate loopback listener, off unless API_OPS_PORT is set. It has no authentication.
const opsPort=process.env.API_OPS_PORT;
if(opsPort){
  const port=Number(opsPort);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('API_OPS_PORT must be a port number');
  const ops=await startOpsServer({port,host:process.env.API_OPS_HOST??'127.0.0.1',metrics});app.addHook('onClose',ops.close);
}
app.addHook('onClose',database.close);
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>void app.close());
await app.listen({host:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??4000)});
