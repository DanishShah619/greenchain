import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database} from '../../../kernel/database.js';
import type {Actor} from '../../capture/application/capture.js';
import {acceptPartial,cancelOrder,createOrder,getOrder,listOrders,type MarketConfig} from '../application/orders.js';
import {inventory} from '../application/inventory.js';
import {handlePaymentEvent,startPaymentAttempt,type PaymentConfig} from '../application/payments.js';
import {SIMULATED_OUTCOMES,presenterInvariantReport,presenterOrders,simulate,type SimulatedOutcome} from '../infrastructure/simulator.js';
import {WorkflowError} from '../../../kernel/errors.js';
import type {Metrics} from '../../../kernel/metrics.js';
import {requirePresenter,type PresenterPolicy} from '../../../kernel/presenter.js';
import {SHOWCASE_MARKET} from '../application/seed.js';
import {getCertificate,issueCertificate,verifyCertificate} from '../application/certificates.js';
import {CREDIT_ID,getRetirementCertificate,listRetirements,PURPOSE,REPORTING_PERIOD,retireCredits} from '../application/retirements.js';
export type MarketRoutesConfig={market:MarketConfig;payments:PaymentConfig;demoMode:boolean;webhookRatePerMinute?:number;
  /** Accounts allowed to use presenter controls (docs/23 P11); defaults to the seeded `presenter`. */presenterIds?:string[];
  /** Public certificate verifications per minute per address (docs/24 C5); default 60. */certificateRatePerMinute?:number;
  /** Optional; declare with declareMarketApiMetrics. */metrics?:Metrics};
export const WEBHOOK_PATH='/api/v1/payments/webhooks/simulator';
type ResolveActor=(request:FastifyRequest,write?:boolean)=>Promise<Actor>;
const uuid={type:'string',format:'uuid'} as const;
const idParams={type:'object',additionalProperties:false,required:['id'],properties:{id:uuid}} as const;
// The service re-checks all of these (and that an FY period names consecutive years); the schema answers malformed input with 400.
const retireTerms={requestId:uuid,reportingPeriod:{type:'string',pattern:REPORTING_PERIOD.source},purpose:{type:'string',maxLength:120,pattern:PURPOSE.source}} as const;
export const presenterPolicy=(config:MarketRoutesConfig):PresenterPolicy=>({demoMode:config.demoMode,presenterIds:config.presenterIds??['presenter'],publicScenarioId:SHOWCASE_MARKET.scenarioId});
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
  // Purchase certificates (docs/24): the buyer issues and views its own; anyone can verify one by number.
  app.post<{Params:{id:string}}>('/api/v1/orders/:id/certificate',{schema:{params:idParams}},async(request,reply)=>{
    const result=await issueCertificate(db,await actor(request,true),request.params.id);
    return reply.code(result.replayed?200:201).send(result);
  });
  app.get<{Params:{id:string}}>('/api/v1/orders/:id/certificate',{schema:{params:idParams}},async request=>getCertificate(db,await actor(request),request.params.id));
  // Retirement (docs/25): the buyer retires credits it bought, by count from one paid order or by credit ids across its orders.
  app.post<{Params:{id:string};Body:{requestId:string;count:number;reportingPeriod:string;purpose?:string}}>('/api/v1/orders/:id/retirements',{schema:{params:idParams,
    body:{type:'object',additionalProperties:false,required:['requestId','count','reportingPeriod'],properties:{...retireTerms,count:{type:'integer',minimum:1,maximum:100}}}}},async(request,reply)=>{
    const result=await retireCredits(db,await actor(request,true),{...request.body,orderId:request.params.id});
    return reply.code(result.replayed?200:201).send(result);
  });
  app.post<{Body:{requestId:string;creditIds:string[];reportingPeriod:string;purpose?:string}}>('/api/v1/retirements',{schema:{body:{type:'object',additionalProperties:false,
    required:['requestId','creditIds','reportingPeriod'],properties:{...retireTerms,creditIds:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'string',pattern:CREDIT_ID.source}}}}}},async(request,reply)=>{
    const result=await retireCredits(db,await actor(request,true),request.body);
    return reply.code(result.replayed?200:201).send(result);
  });
  app.get('/api/v1/retirements',async request=>listRetirements(db,await actor(request)));
  app.get<{Params:{id:string}}>('/api/v1/retirements/:id/certificate',{schema:{params:idParams}},async request=>getRetirementCertificate(db,await actor(request),request.params.id));
  const verifyLimit=config.certificateRatePerMinute??60,verifySeen=new Map<string,{windowStart:number;count:number}>();
  app.get<{Params:{number:string};Querystring:{hash?:string}}>('/api/v1/certificates/:number',{schema:{
    params:{type:'object',additionalProperties:false,required:['number'],properties:{number:{type:'string',pattern:'^GC-(DEMO|RETIRE)-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'}}},
    querystring:{type:'object',additionalProperties:false,properties:{hash:{type:'string',pattern:'^[0-9a-f]{64}$'}}}}},async(request,reply)=>{
    const now=Date.now(),entry=verifySeen.get(request.ip);
    if(!entry||now-entry.windowStart>=60_000)verifySeen.set(request.ip,{windowStart:now,count:1});
    else if(++entry.count>verifyLimit)return reply.header('Retry-After','60').code(429).send({code:'RATE_LIMITED',retryable:true});
    if(verifySeen.size>10_000)verifySeen.clear();
    return verifyCertificate(db,request.params.number,request.query.hash);
  });
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
        // An apply that failed is counted whether the event goes back to the provider (503) or is parked on this delivery.
        if(result.status>=500||result.justParked)metrics?.inc('greenchain_payment_event_failures_total',{code:result.code==='EVENT_PARKED'?'PAYMENT_APPLY_FAILED':result.code??'UNKNOWN'});
        if(result.justParked)metrics?.inc('greenchain_payment_events_parked_total');
        else if(result.outcome)metrics?.inc('greenchain_payment_events_applied_total',{outcome:result.outcome});
        else if(result.status<500&&!result.parked)metrics?.inc('greenchain_webhook_rejected_total',{reason:result.code??'UNKNOWN'});
        // The provider event id is the provider's own reference (not a secret). `error` holds only an error class and machine code.
        const cause={eventId:result.eventId,...result.error,...(result.failureNotRecorded?{failureNotRecorded:true}:{})};
        if(result.justParked)request.log.error({code:result.code,...cause},'Payment event parked after repeated failures; an operator must retry it (npm run payments)');
        else if(result.status>=500)request.log.error({code:result.code,...cause},'Payment event could not be applied; the provider will retry');
        else if(result.status!==200)request.log.warn({code:result.code,status:result.status,eventId:result.eventId},'Payment event rejected');
        const response=result.parked?{received:true,parked:true}:result.status===200?{received:true,outcome:result.outcome,replayed:result.replayed??false}:{code:result.code,retryable:result.status>=500};
        return reply.code(result.status).send(response);
      });
    });
  }
  // Presenter controls for the simulated provider. Only in demo mode; absent (404) otherwise. Only the allow-listed presenter.
  if(config.demoMode&&config.payments.secrets.length){
    const policy=presenterPolicy(config);
    const presenter=async(request:FastifyRequest,write=false)=>{const who=await actor(request,write);await requirePresenter(db,who,policy);return who;};
    app.get('/api/v1/demo/orders',async request=>presenterOrders(db,await presenter(request)));
    app.get('/api/v1/demo/invariants',async request=>presenterInvariantReport(db,await presenter(request)));
    app.get<{Params:{id:string}}>('/api/v1/demo/orders/:id/certificate',{schema:{params:idParams}},async request=>getCertificate(db,await presenter(request),request.params.id,{asPresenter:true}));
    app.post<{Params:{id:string}}>('/api/v1/demo/orders/:id/certificate',{schema:{params:idParams}},async(request,reply)=>{
      const result=await issueCertificate(db,await presenter(request,true),request.params.id,{asPresenter:true});
      return reply.code(result.replayed?200:201).send(result);
    });
    app.post<{Params:{id:string};Body:{outcome:SimulatedOutcome}}>('/api/v1/demo/orders/:id/simulate',{schema:{params:idParams,body:{type:'object',additionalProperties:false,
      required:['outcome'],properties:{outcome:{enum:[...SIMULATED_OUTCOMES]}}}}},async(request,reply)=>{
      const result=await simulate(db,await presenter(request,true),request.params.id,request.body.outcome,config.payments);
      // Simulated deliveries call the handler in-process, so count them here; they never pass through the webhook route.
      if('outcome' in result&&result.outcome)metrics?.inc('greenchain_payment_events_applied_total',{outcome:result.outcome});
      else if(result.status>=500)metrics?.inc('greenchain_payment_event_failures_total',{code:('code' in result&&result.code)||'UNKNOWN'});
      return reply.code(result.status).send(result);
    });
  }
}
