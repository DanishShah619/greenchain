import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database} from '../../../kernel/database.js';
import type {Actor} from '../../capture/application/capture.js';
import {review} from '../application/demo.js';
export async function registerCalculationReviewRoutes(app:FastifyInstance,db:Database,actor:(request:FastifyRequest,write?:boolean)=>Promise<Actor>,ports:Parameters<typeof review>[5]){
  app.post<{Params:{id:string;runId:string};Body:Parameters<typeof review>[4]}>('/api/v1/cases/:id/demo-calculations/:runId/review',{schema:{
    params:{type:'object',required:['id','runId'],properties:{id:{type:'string',format:'uuid'},runId:{type:'string',format:'uuid'}}},
    body:{type:'object',additionalProperties:false,required:['decisionId','expectedGeneration','inputsHash','decision','reason'],properties:{decisionId:{type:'string',format:'uuid'},expectedGeneration:{type:'integer',minimum:1},inputsHash:{type:'string',pattern:'^[a-f0-9]{64}$'},decision:{enum:['APPROVED','REJECTED']},reason:{type:'string',minLength:10,maxLength:500}}}
  }},async request=>review(db,await actor(request,true),request.params.id,request.params.runId,request.body,ports));
}
