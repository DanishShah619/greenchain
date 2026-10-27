import {connectDatabase} from './database.js';
import {auditKeyFromEnvironment} from '../kernel/audit-key.js';
import {createLogger} from '../kernel/logger.js';
import {Metrics} from '../kernel/metrics.js';
import {amoyFromEnvironment} from '../modules/chain/infrastructure/evm.js';
import {policyFromEnvironment} from '../modules/chain/application/policy.js';
import {declareWorkerMetrics,newHealthState,nextSleepMs,workerCycle} from '../modules/ops/application/iteration.js';
import {startOpsServer,type OpsServer} from './ops-server.js';
import {marketConfig} from './config.js';
import {newSweepState,sweepConfigFromEnvironment} from '../modules/market/application/sweep.js';
import {newPayoutSweepState} from '../modules/payouts/application/sweep.js';
import {SandboxRail} from '../modules/payouts/infrastructure/sandbox-rail.js';
const log=createLogger('greenchain-worker');
function integer(name:string,fallback:number,min:number,max:number){
  const raw=process.env[name];if(raw===undefined||raw==='')return fallback;
  const value=Number(raw);
  if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
// Configuration errors are fatal and loud at startup; once running, no single cycle may take the process down.
let database:ReturnType<typeof connectDatabase>|undefined,chain:Awaited<ReturnType<typeof amoyFromEnvironment>>,ops:OpsServer|undefined;
try {
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const policy=policyFromEnvironment(),fullVerifyHours=integer('AUDIT_FULL_VERIFY_HOURS',24,0,24*30),maxAgeSeconds=integer('HEALTH_MAX_AGE_SECONDS',120,10,3600);
  const opsSetting=process.env.WORKER_OPS_PORT??'4100',opsPort=opsSetting==='off'?0:integer('WORKER_OPS_PORT',4100,1,65535);
  database=connectDatabase(process.env.DATABASE_URL,auditKeyFromEnvironment());chain=await amoyFromEnvironment();
  const routes=marketConfig(),market={config:sweepConfigFromEnvironment(routes.market),state:newSweepState()};
  // Payouts run only in demo mode, against the sandbox rail (the only rail; docs/23 P9).
  const payouts=routes.demoMode?{rail:new SandboxRail(database.db),state:newPayoutSweepState(),invariantEverySeconds:market.config.invariantEverySeconds}:undefined;
  const metrics=new Metrics(),health=newHealthState('worker');declareWorkerMetrics(metrics);
  if(opsPort)ops=await startOpsServer({port:opsPort,host:process.env.WORKER_OPS_HOST??'127.0.0.1',metrics,health,maxAgeMs:maxAgeSeconds*1000});
  let stopped=false,wake:(()=>void)|undefined;
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{stopped=true;wake?.();});
  log.info({chainConfigured:Boolean(chain),opsPort:ops?.port??null,fullVerifyHours,policy,market:{refundSettleAfterSeconds:market.config.refundSettleAfterSeconds,invariantEverySeconds:market.config.invariantEverySeconds},payouts:Boolean(payouts)},'Worker started');
  while(!stopped){
    const outcome=await workerCycle({db:database.db,chain,log,metrics,health,fullVerifyEveryMs:fullVerifyHours*3_600_000,cycle:{policy},market,payouts});
    const sleep=nextSleepMs(outcome,health.consecutiveFailures);
    if(!stopped)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,sleep);wake=()=>{clearTimeout(timer);resolve();};});
  }
  log.info({},'Worker stopping');
} catch (error) {
  log.error({message:error instanceof Error?error.message:'Unknown error'},'Worker could not start or hit a fatal configuration error');
  process.exitCode=1;
} finally {await ops?.close();chain?.close();await database?.close();}
