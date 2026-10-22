import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database} from '../../../kernel/database.js';
import type {Actor} from '../../capture/application/capture.js';
import {acceptPartial,cancelOrder,createOrder,getOrder,listOrders,type MarketConfig} from '../application/orders.js';
import {inventory} from '../application/inventory.js';
import {handlePaymentEvent,startPaymentAttempt,type PaymentConfig} from '../application/payments.js';
import {SIMULATED_OUTCOMES,presenterInvariantReport,presenterOrders,simulate,type SimulatedOutcome} from '../infrastructure/simulator.js';
import {WorkflowError} from '../../../kernel/errors.js';
import type {Metrics} from '../../../kernel/metrics.js';
export type MarketRoutesConfig={market:MarketConfig;payments:PaymentConfig;demoMode:boolean;webhookRatePerMinute?:number;
  /** Optional; declare with declareMarketApiMetrics. */metrics?:Metrics};
export const WEBHOOK_PATH='/api/v1/payments/webhooks/simulator';
type ResolveActor=(request:FastifyRequest,write?:boolean)=>Promise<Actor>;
const uuid={type:'string',format:'uuid'} as const;
const idParams={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
export async function registerMarketRoutes(app:FastifyInstance,db:Database,actor:ResolveActor,config:MarketRoutesConfig){
  const metrics=config.metrics;
  app.get('/api/v1/market/inventory',async request=>inventory(db,await actor(request)));
  app.get('/api/v1/orders',async request=>listOrders(db,await actor(request)));
  app.get<{Params:{id:string}}>('/api/v1/orders/:id',{schema:{params:idParams}},async request=>getOrder(db,await actor(request),request.params.id));
  app.post<{Body:{requestId:string;quantity:number;quotedTotalPaise?:string}}>('/api/v1/orders',{schema:{body:{type:'object',additionalProperties:false,required:['requestId','quantity'],
    properties:{requestId:uuid,quantity:{type:'integer',minimum:1,maximum:100},quotedTotalPaise:{type:'string',pattern:'^[0-9]{1,18}$'}}}}},async(request,reply)=>{
    const who=await actor(request,true);
    try{
      const view=await createOrder(db,who,request.body,config.market);
      metrics?.inc('greenchain_orders_created_total',{result:view.replayed?'replay':view.order.state==='RESERVED'?'reserved':'shortfall'});
      return reply.code(view.replayed?200:201).send(view);
    }catch(error){metrics?.inc('greenchain_orders_created_total',{result:error instanceof WorkflowError?error.code:'error'});throw error;}
  });
  app.post<{Params:{id:string}}>('/api/v1/orders/:id/accept-partial',{schema:{params:idParams}},async request=>acceptPartial(db,await actor(request,true),request.params.id,config.market));
  app.post<{Params:{id:string}}>('/api/v1/orders/:id/cancel',{schema:{params:idParams}},async request=>cancelOrder(db,await actor(request,true),request.params.id));
  app.post<{Params:{id:string};Body:{acceptSnapshotHash:string}}>('/api/v1/orders/:id/payment-attempts',{schema:{params:idParams,body:{type:'object',additionalProperties:false,
    required:['acceptSnapshotHash'],properties:{acceptSnapshotHash:{type:'string',pattern:'^[0-9a-f]{64}$'}}}}},async request=>startPaymentAttempt(db,await actor(request,true),request.params.id,request.body,config.market,config.payments.provider));
  // The provider webhook exists only when a secret is configured. It is authenticated by signature, not by cookie or CSRF,
  // and it needs the raw bytes: the signature covers the exact body, so the JSON parser is replaced inside this scope only.
  if(config.payments.secrets.length){
    const limit=config.webhookRatePerMinute??300,seen=new Map<string,{windowStart:number;count:number}>();
    await app.register(async scope=>{
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:config.payments.maxBodyBytes},(_request,body,done)=>done(null,body));
      scope.post(WEBHOOK_PATH,async(request,reply)=>{
        const now=Date.now(),entry=seen.get(request.ip);
        if(!entry||now-entry.windowStart>=60_000)seen.set(request.ip,{windowStart:now,count:1});
        else if(++entry.count>limit){metrics?.inc('greenchain_webhook_requests_total',{status:'429'});return reply.header('Retry-After','60').code(429).send({code:'RATE_LIMITED',retryable:true});}
        if(seen.size>10_000)seen.clear();
        const header=(name:string)=>{const v=request.headers[name];return typeof v==='string'?v:undefined;};
        const result=await handlePaymentEvent(db,{body:Buffer.isBuffer(request.body)?request.body:Buffer.alloc(0),signature:header('x-greenchain-signature'),timestamp:header('x-greenchain-timestamp')},config.payments);
        metrics?.inc('greenchain_webhook_requests_total',{status:String(result.status)});
        if(result.status===200)metrics?.inc('greenchain_payment_events_applied_total',{outcome:result.outcome!});
        else if(result.status>=500)metrics?.inc('greenchain_payment_event_failures_total',{code:result.code??'UNKNOWN'});
        else metrics?.inc('greenchain_webhook_rejected_total',{reason:result.code??'UNKNOWN'});
        // The provider event id is the provider's own reference (not a secret); it lets an operator find repeated failures.
        if(result.status>=500)request.log.error({code:result.code,eventId:result.eventId},'Payment event could not be applied; the provider will retry');
        else if(result.status!==200)request.log.warn({code:result.code,status:result.status,eventId:result.eventId},'Payment event rejected');
        return reply.code(result.status).send(result.status===200?{received:true,outcome:result.outcome,replayed:result.replayed??false}:{code:result.code,retryable:result.status>=500});
      });
    });
  }
  // Presenter controls for the simulated provider. Only in demo mode; absent (404) otherwise.
  if(config.demoMode&&config.payments.secrets.length){
    app.get('/api/v1/demo/orders',async request=>presenterOrders(db,await actor(request)));
    app.get('/api/v1/demo/invariants',async request=>presenterInvariantReport(db,await actor(request)));
    app.post<{Params:{id:string};Body:{outcome:SimulatedOutcome}}>('/api/v1/demo/orders/:id/simulate',{schema:{params:idParams,body:{type:'object',additionalProperties:false,
      required:['outcome'],properties:{outcome:{enum:[...SIMULATED_OUTCOMES]}}}}},async(request,reply)=>{
      const result=await simulate(db,await actor(request,true),request.params.id,request.body.outcome,config.payments);
      // Simulated deliveries call the handler in-process, so count them here; they never pass through the webhook route.
      if('outcome' in result&&result.outcome)metrics?.inc('greenchain_payment_events_applied_total',{outcome:result.outcome});
      else if(result.status>=500)metrics?.inc('greenchain_payment_event_failures_total',{code:('code' in result&&result.code)||'UNKNOWN'});
      return reply.code(result.status).send(result);
    });
  }
}
