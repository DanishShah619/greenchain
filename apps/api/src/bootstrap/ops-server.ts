import {createServer} from 'node:http';
import type {Metrics} from '../kernel/metrics.js';
import type {HealthState} from '../modules/ops/application/iteration.js';
export type OpsServer={port:number;close():Promise<void>};
/**
 * A tiny read-only HTTP endpoint for the worker: GET /healthz and GET /metrics. It has no authentication, so it binds
 * to loopback by default; expose it beyond the host only behind network controls. It never returns secrets or record data.
 */
export function startOpsServer(options:{port:number;host:string;metrics:Metrics;health?:HealthState;maxAgeMs?:number;now?:()=>number}):Promise<OpsServer>{
  const now=options.now??Date.now;
  const server=createServer((request,response)=>{
    const send=(status:number,type:string,body:string,extra:Record<string,string>={})=>{response.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff',...extra});response.end(body);};
    if(request.method!=='GET')return send(405,'application/json','{"code":"METHOD_NOT_ALLOWED"}',{allow:'GET'});
    const path=(request.url??'').split('?')[0];
    if(path==='/metrics')return send(200,'text/plain; version=0.0.4; charset=utf-8',options.metrics.render());
    if(path==='/healthz'&&!options.health)return send(200,'application/json','{"status":"ok"}');
    if(path==='/healthz'&&options.health){
      const h=options.health,maxAgeMs=options.maxAgeMs??120_000,sinceStart=now()-h.startedAt,age=h.lastSuccessAt===null?undefined:now()-h.lastSuccessAt;
      let status:'ok'|'starting'|'degraded'|'unavailable',reason:string|undefined;
      if(h.integrityFailed){status='degraded';reason='AUDIT_INTEGRITY_FAILED';}
      else if(age===undefined&&sinceStart<=maxAgeMs)status='starting';
      else if(age===undefined||age>maxAgeMs){status='unavailable';reason=h.lastErrorCode??'NO_RECENT_CYCLE';}
      else status='ok';
      return send(status==='ok'||status==='starting'?200:503,'application/json',JSON.stringify({status,...(reason?{reason}:{}),lastCycleAgeSeconds:age===undefined?null:Math.round(age/1000),consecutiveFailures:h.consecutiveFailures}));
    }
    return send(404,'application/json','{"code":"NOT_FOUND"}');
  });
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(options.port,options.host,()=>{
      const address=server.address();
      resolve({port:typeof address==='object'&&address?address.port:options.port,close:()=>new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections?.();})});
    });
  });
}
