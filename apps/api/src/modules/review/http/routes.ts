import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database} from '../../../kernel/database.js';
import type {Actor} from '../../capture/application/capture.js';
import * as workflow from '../application/workflow.js';
const uuid={type:'string',format:'uuid'},integer={type:'integer',minimum:1},params={type:'object',required:['id'],properties:{id:uuid}};
const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
export async function registerReviewRoutes(app:FastifyInstance,db:Database,actor:(request:FastifyRequest,write?:boolean)=>Promise<Actor>){
  app.get<{Params:{id:string}}>('/api/v1/cases/:id',{schema:{params}},async request=>workflow.detail(db,await actor(request),request.params.id));
  app.get('/api/v1/verification/cases',async request=>workflow.queue(db,await actor(request)));
  app.put<{Params:{id:string};Body:Parameters<typeof workflow.saveBoundary>[3]}>('/api/v1/cases/:id/boundary',{schema:{params,body:object({requestId:uuid,expectedVersion:integer,boundary:{type:'object',additionalProperties:false,required:['type','coordinates'],properties:{type:{const:'Polygon'},coordinates:{type:'array',minItems:1,maxItems:1,items:{type:'array',minItems:4,maxItems:65,items:{type:'array',minItems:2,maxItems:2,items:{type:'number'}}}}}}})}},async request=>workflow.saveBoundary(db,await actor(request,true),request.params.id,request.body));
  app.post<{Params:{id:string};Body:workflow.UploadInput}>('/api/v1/cases/:id/uploads',{schema:{params,body:object({uploadId:uuid,slot:{enum:['land_rights','plot_photo']},mime:{enum:['image/png','image/jpeg']},size:{type:'integer',minimum:1,maximum:2097152},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},filename:{type:'string',minLength:1,maxLength:120,pattern:'^[^\\/\\\\]+$'}})}},async request=>workflow.beginUpload(db,await actor(request,true),request.params.id,request.body));
  app.put<{Params:{id:string;index:number};Body:{data:string}}>('/api/v1/uploads/:id/chunks/:index',{bodyLimit:360000,schema:{params:{type:'object',required:['id','index'],properties:{id:uuid,index:{type:'integer',minimum:0,maximum:7}}},body:object({data:{type:'string',maxLength:349528,minLength:4}})}},async request=>workflow.uploadChunk(db,await actor(request,true),request.params.id,request.params.index,request.body.data));
  app.post<{Params:{id:string}}>('/api/v1/uploads/:id/complete',{schema:{params}},async request=>workflow.completeUpload(db,await actor(request,true),request.params.id));
  app.get<{Params:{id:string}}>('/api/v1/uploads/:id/preview',{schema:{params}},async(request,reply)=>{
    const data=await workflow.preview(db,await actor(request),request.params.id);
    return reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Content-Disposition','inline; filename="demo-evidence.png"').type('image/png').send(data);
  });
  app.post<{Params:{id:string};Body:{expectedVersion:number}}>('/api/v1/cases/:id/submit',{schema:{params,body:object({expectedVersion:integer})}},async request=>workflow.submit(db,await actor(request,true),request.params.id,request.body.expectedVersion));
  app.post<{Params:{id:string};Body:Parameters<typeof workflow.decide>[3]}>('/api/v1/verification/cases/:id/decision',{schema:{params,body:object({decisionId:uuid,expectedVersion:integer,decision:{enum:['EVIDENCE_APPROVED','REJECTED']},reason:{type:'string',minLength:10,maxLength:500}})}},async request=>workflow.decide(db,await actor(request,true),request.params.id,request.body));
}
