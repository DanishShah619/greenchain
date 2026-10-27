import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database} from '../../../kernel/database.js';
import {requirePresenter,type PresenterPolicy} from '../../../kernel/presenter.js';
import type {Actor} from '../../capture/application/capture.js';
import {SANDBOX_SUFFIXES,CLOCK_MAX_OFFSET_SECONDS,CLOCK_MAX_STEP_SECONDS} from '../domain/config.js';
import type {PayoutRail} from '../domain/rail.js';
import {caseStatement,presenterAdvanceClock,presenterCancel,presenterPanel,presenterRunBatch,presenterSetConfig,presenterSetSuffix,type ConfigInput} from '../application/presenter.js';
/**
 * Payout routes (docs/23 §6.4). The statement is always available to the case's agent; presenter controls exist only in demo
 * mode and only for the allow-listed presenter (P11). Writes need CSRF (the actor resolver checks it when write is true).
 */
type ResolveActor=(request:FastifyRequest,write?:boolean)=>Promise<Actor>;
const uuid={type:'string',format:'uuid'} as const;
const paise={type:'string',pattern:'^[1-9][0-9]{0,15}$'} as const;
const body=(required:string[],properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required,properties});
export async function registerPayoutRoutes(app:FastifyInstance,db:Database,actor:ResolveActor,o:{policy:PresenterPolicy;rail:PayoutRail}){
  app.get<{Params:{id:string}}>('/api/v1/cases/:id/statement',{schema:{params:body(['id'],{id:uuid})}},async request=>caseStatement(db,await actor(request),request.params.id));
  if(!o.policy.demoMode)return;
  const presenter=async(request:FastifyRequest,write=false)=>{const who=await actor(request,write);await requirePresenter(db,who,o.policy);return who;};
  app.get('/api/v1/demo/payouts',async request=>presenterPanel(db,await presenter(request)));
  app.post<{Body:{expectedOffsetSeconds:number;advanceSeconds:number}}>('/api/v1/demo/clock',{schema:{body:body(['expectedOffsetSeconds','advanceSeconds'],{
    expectedOffsetSeconds:{type:'integer',minimum:0,maximum:CLOCK_MAX_OFFSET_SECONDS},advanceSeconds:{type:'integer',minimum:1,maximum:CLOCK_MAX_STEP_SECONDS}})}},
    async request=>presenterAdvanceClock(db,await presenter(request,true),request.body));
  app.post<{Body:{requestId:string}}>('/api/v1/demo/payouts/batch',{schema:{body:body(['requestId'],{requestId:uuid})}},
    async request=>presenterRunBatch(db,await presenter(request,true),request.body));
  app.put<{Body:ConfigInput}>('/api/v1/demo/ledger-config',{schema:{body:body(['holdbackDays','reserveBps','minPayoutPaise','payoutLimitPaise'],{
    holdbackDays:{type:'integer',minimum:0,maximum:365},reserveBps:{type:'integer',minimum:0,maximum:10000},minPayoutPaise:paise,payoutLimitPaise:paise,
    backoffBaseSeconds:{type:'integer',minimum:1,maximum:3600},idempotencyWindowSeconds:{type:'integer',minimum:60,maximum:604800}})}},
    async request=>presenterSetConfig(db,await presenter(request,true),request.body));
  app.post<{Params:{code:string};Body:{suffix:typeof SANDBOX_SUFFIXES[number]}}>('/api/v1/demo/payees/:code/sandbox',{schema:{params:body(['code'],{code:{type:'string',pattern:'^[0-9A-F]{6}$'}}),
    body:body(['suffix'],{suffix:{enum:[...SANDBOX_SUFFIXES]}})}},async request=>presenterSetSuffix(db,await presenter(request,true),request.params.code,request.body.suffix));
  app.post<{Params:{id:string};Body:{requestId:string;reason:string}}>('/api/v1/demo/payouts/:id/cancel',{schema:{params:body(['id'],{id:uuid}),
    body:body(['requestId','reason'],{requestId:uuid,reason:{type:'string',minLength:3,maxLength:200,pattern:'\\S'}})}},
    async request=>presenterCancel(db,await presenter(request,true),request.params.id,request.body,o.rail));
}
