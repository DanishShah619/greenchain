import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database} from '../../../kernel/database.js';
import {requirePresenter,type PresenterPolicy} from '../../../kernel/presenter.js';
import type {Actor} from '../../capture/application/capture.js';
import {resetPresenterScenario} from '../application/reset.js';
type ResolveActor=(request:FastifyRequest,write?:boolean)=>Promise<Actor>;
/** The presenter's safe reset (docs/24 §2): demo mode only, presenter only, CSRF, a typed confirmation and a request id. */
export async function registerDemoRoutes(app:FastifyInstance,db:Database,actor:ResolveActor,policy:PresenterPolicy){
  if(!policy.demoMode)return;
  app.post<{Body:{requestId:string;confirm:'RESET'}}>('/api/v1/demo/reset',{schema:{body:{type:'object',additionalProperties:false,required:['requestId','confirm'],
    properties:{requestId:{type:'string',format:'uuid'},confirm:{const:'RESET'}}}}},async request=>{
    const who=await actor(request,true);await requirePresenter(db,who,policy);
    return resetPresenterScenario(db,who,request.body);
  });
}
