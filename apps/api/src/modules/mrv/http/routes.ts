import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database} from '../../../kernel/database.js';
import type {Actor} from '../../capture/application/capture.js';
import {calculate,list,submitCandidate,type DemoCasePort} from '../application/demo.js';
import type {Preset} from '../domain/demo.js';
export async function registerDemoCalculationRoutes(app:FastifyInstance,db:Database,actor:(request:FastifyRequest,write?:boolean)=>Promise<Actor>,casePort:DemoCasePort,authorize:(db:Database,actor:Actor,id:string)=>Promise<unknown>,reviewStatus:(db:Database,actor:Actor,id:string)=>Promise<unknown>){
  const params={type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}};
  app.post<{Params:{id:string;runId:string};Body:{requestId:string;expectedGeneration:number;inputsHash:string}}>('/api/v1/cases/:id/demo-calculations/:runId/submit',{schema:{params:{type:'object',required:['id','runId'],properties:{id:{type:'string',format:'uuid'},runId:{type:'string',format:'uuid'}}},body:{type:'object',additionalProperties:false,required:['requestId','expectedGeneration','inputsHash'],properties:{requestId:{type:'string',format:'uuid'},expectedGeneration:{type:'integer',minimum:1},inputsHash:{type:'string',pattern:'^[a-f0-9]{64}$'}}}}},async request=>submitCandidate(db,await actor(request,true),request.params.id,request.params.runId,request.body,casePort));
  app.get<{Params:{id:string}}>('/api/v1/cases/:id/demo-calculations',{schema:{params}},async request=>{
    const user=await actor(request),history=await list(db,user,request.params.id,authorize);
    return {...history,reviews:await reviewStatus(db,user,request.params.id)};
  });
  app.post<{Params:{id:string};Body:{requestId:string;expectedVersion:number;preset:Preset}}>('/api/v1/cases/:id/demo-calculations',{schema:{params,body:{type:'object',additionalProperties:false,required:['requestId','expectedVersion','preset'],properties:{requestId:{type:'string',format:'uuid'},expectedVersion:{type:'integer',minimum:1},preset:{enum:['standard','cloudy','no-uplift','insufficient']}}}}},async(request,reply)=>{
    const result=await calculate(db,await actor(request,true),request.params.id,request.body,casePort);
    return reply.code(result.replayed?200:201).send(result);
  });
}
