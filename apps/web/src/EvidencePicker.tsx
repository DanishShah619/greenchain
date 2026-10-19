'use client';
import {useEffect,useState} from 'react';
import {evidence,type Evidence} from './outbox';
export function EvidencePicker({ownerId,eventId}:{ownerId:string;eventId:string}){
  const [items,setItems]=useState<Evidence[]>([]),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  async function refresh(){setItems(await evidence.where('eventId').equals(eventId).filter(item=>item.ownerId===ownerId).toArray());}
  useEffect(()=>{refresh().catch(()=>setMessage('Evidence storage is unavailable.'));},[eventId,ownerId]);
  async function save(file:File|undefined,slot:Evidence['slot']){
    if(!file)return;setBusy(true);
    try{
      if(!['image/png','image/jpeg'].includes(file.type)||file.size===0||file.size>2097152)throw new Error('Choose a PNG or JPEG image up to 2 MiB.');
      const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
      await evidence.db.transaction('rw',evidence,async()=>{
        const previous=await evidence.where('[eventId+slot]').equals([eventId,slot]).first();
        if(previous?.state==='complete')throw new Error('Synced evidence is locked. Create a new onboarding record for corrections.');
        if(previous)await evidence.delete(previous.id);
        await evidence.add({id:crypto.randomUUID(),ownerId,eventId,slot,blob:file,filename:file.name.slice(0,120),mime:file.type as Evidence['mime'],sha256,state:'pending'});
      });
      await refresh();setMessage('Image saved on this device. It will be validated during sync.');
    }catch(error){setMessage(error instanceof Error?error.message:'The image could not be saved.');}finally{setBusy(false);}
  }
  async function samples(){
    for(const slot of ['land_rights','plot_photo'] as const){
      const canvas=document.createElement('canvas');canvas.width=480;canvas.height=320;
      const context=canvas.getContext('2d');if(!context){setMessage('Sample image generation is unavailable.');return;}
      context.fillStyle='#edf3e6';context.fillRect(0,0,480,320);context.fillStyle='#256348';context.font='bold 24px sans-serif';context.fillText('SYNTHETIC DEMO',32,60);context.font='18px sans-serif';context.fillText(slot==='land_rights'?'Invented land-rights proof':'Invented plot photo',32,110);context.strokeStyle='#63855c';context.strokeRect(32,145,220,100);context.fillText('No real person or document',32,290);
      const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));
      if(blob)await save(new File([blob],`synthetic-${slot}.png`,{type:'image/png'}),slot);
    }
  }
  return <section><p className="help">Use synthetic placeholder images only. Two images are required: a demo land-rights proof and a demo plot photo. PNG/JPEG, up to 2 MiB each.</p><button type="button" disabled={busy} className="secondary" onClick={()=>void samples()}>Use two synthetic sample images</button>{(['land_rights','plot_photo'] as const).map(slot=><label key={slot}>{slot==='land_rights'?'Synthetic land-rights image':'Synthetic plot photo'}<input disabled={busy} type="file" accept="image/png,image/jpeg" onChange={e=>void save(e.target.files?.[0],slot)}/><span className="help">{items.find(item=>item.slot===slot)?.filename??'No image saved yet'}</span></label>)}<p role="status" className="status">{message}</p></section>;
}
