import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database} from '../../../kernel/database.js';
import type {Actor} from '../../capture/application/capture.js';
import {inventory} from '../application/demo.js';
export async function registerDemoRegistryRoutes(app:FastifyInstance,db:Database,actor:(request:FastifyRequest)=>Promise<Actor>,authorize:(db:Database,actor:Actor,id:string)=>Promise<unknown>){
  app.get<{Params:{id:string};Querystring:{after?:number}}>('/api/v1/cases/:id/demo-issuance',{schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}},querystring:{type:'object',additionalProperties:false,properties:{after:{type:'integer',minimum:0,maximum:20000}}}}},async request=>inventory(db,await actor(request),request.params.id,request.query.after??0,authorize));
}
