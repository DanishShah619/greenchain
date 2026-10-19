import Dexie, {type EntityTable} from 'dexie';
import type {Boundary} from '@greenchain/geometry';
export type Onboarding={version:1;language:'en'|'hi'|'bn';district:string;plotLabel:string;landRight:'owner'|'consented_cultivator';crop:string;season:'kharif'|'rabi'|'zaid'|'perennial';consentVersion:'demo-consent-v1'|'demo-consent-v2';purpose:'demo-onboarding'};
export type Draft={eventId:string;ownerId:string;farmerLabel:string;village:string;areaHectares:string;consent:true;onboarding?:Onboarding;boundary?:Boundary;state:'pending'|'synced'|'rejected';error?:string};
export type Evidence={id:string;ownerId:string;eventId:string;slot:'land_rights'|'plot_photo';blob:Blob;filename:string;mime:'image/png'|'image/jpeg';sha256:string;state:'pending'|'complete'};
type Setting={key:string;value:unknown};
const database=new Dexie('greenchain-demo-captures') as Dexie & {drafts:EntityTable<Draft,'eventId'>;settings:EntityTable<Setting,'key'>;evidence:EntityTable<Evidence,'id'>};
database.version(1).stores({drafts:'eventId,state'});
database.version(2).stores({drafts:'eventId,state,ownerId',settings:'key'}).upgrade(async tx=>{
  await tx.table('drafts').toCollection().modify({ownerId:'presenter'});
});
database.version(3).stores({drafts:'eventId,state,ownerId',settings:'key',evidence:'id,ownerId,eventId,&[eventId+slot]'});
export const drafts=database.drafts;
export const settings=database.settings;
export const evidence=database.evidence;
export {database as deviceDatabase};
export async function syncDrafts(ownerId:string,send:(payload:Omit<Draft,'ownerId'|'state'|'error'>)=>Promise<{eventId:string;status:string}>){
  let accepted=0,rejected=0;
  const pending=await drafts.where('ownerId').equals(ownerId).filter(item=>item.state==='pending').toArray();
  for(const item of pending){
    const {ownerId:owner,state,error,...payload}=item;
    try{
      const ack=await send(payload);
      if(ack.eventId!==item.eventId||ack.status!=='CAPTURED')throw new Error('Server acknowledgement could not be confirmed. Retry sync.');
      await drafts.update(item.eventId,{state:'synced',error:undefined});accepted++;
    }catch(error){
      const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;
      if(['KEY_REUSE','INVALID_INPUT','INVALID_BOUNDARY','INVALID_IMAGE','HASH_MISMATCH','SLOT_ALREADY_RESERVED'].includes(String(code))){
        await drafts.update(item.eventId,{state:'rejected',error:error instanceof Error?error.message:String(code)});rejected++;continue;
      }
      throw error;
    }
  }
  return {accepted,rejected};
}
export async function syncEvidence(ownerId:string,eventId:string,request:(path:string,options?:RequestInit)=>Promise<any>){
  const items=await evidence.where('eventId').equals(eventId).filter(item=>item.ownerId===ownerId).toArray();
  for(const item of items){
    const started=await request(`/cases/${eventId}/uploads`,{method:'POST',body:JSON.stringify({uploadId:item.id,slot:item.slot,mime:item.mime,size:item.blob.size,sha256:item.sha256,filename:item.filename})});
    if(started.uploadId!==item.id||started.chunkSize!==262144)throw new Error('Upload acknowledgement mismatch');
    if(started.status!=='COMPLETE'){
      for(let index=0;index<Math.ceil(item.blob.size/started.chunkSize);index++){
        if(started.received.includes(index))continue;
        const bytes=new Uint8Array(await item.blob.slice(index*started.chunkSize,(index+1)*started.chunkSize).arrayBuffer());
        let raw='';for(let offset=0;offset<bytes.length;offset+=16384)raw+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
        const ack=await request(`/uploads/${item.id}/chunks/${index}`,{method:'PUT',body:JSON.stringify({data:btoa(raw)})});
        if(ack.index!==index||ack.received!==true)throw new Error('Chunk acknowledgement mismatch');
      }
      const complete=await request(`/uploads/${item.id}/complete`,{method:'POST'});
      if(complete.uploadId!==item.id||complete.status!=='COMPLETE')throw new Error('Evidence completion not confirmed');
    }
    await evidence.update(item.id,{state:'complete'});
  }
}
