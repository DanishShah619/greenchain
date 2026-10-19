import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Database} from '../../../kernel/database.js';
import type {Actor} from '../../capture/application/capture.js';
import {verifyAudit} from '../application/audit.js';
export async function registerAuditRoutes(app:FastifyInstance,db:Database,actor:(request:FastifyRequest)=>Promise<Actor>,authorize:(db:Database,actor:Actor,id:string)=>Promise<unknown>){
  app.get<{Params:{id:string}}>('/api/v1/cases/:id/audit',{schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',format:'uuid'}}}}},async request=>{
    const who=await actor(request);await authorize(db,who,request.params.id);
    const audit=await verifyAudit(db);
    const events=(await db.query(`SELECT a.id,a.event_type,a.created_at,COALESCE(a.signed_record->>'origin',l.signed_record->>'origin','LEGACY_UNCHAINED') AS origin,l.chain_seq,l.head_hash
      FROM audit_events a LEFT JOIN audit_chain_links l ON l.event_id=a.id WHERE a.scenario_id=$1 AND a.capture_id=$2 ORDER BY a.created_at DESC,a.id DESC LIMIT 100`,[who.scenarioId,request.params.id])).rows;
    return {audit,events};
  });
}
