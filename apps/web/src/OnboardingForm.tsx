'use client';
import {useEffect,useState,useRef,type FormEvent} from 'react';
import {drafts,settings,evidence,type Onboarding} from './outbox';
import {validateBoundary,type Boundary} from '@greenchain/geometry';
import {BoundaryEditor} from './BoundaryEditor';
import {EvidencePicker} from './EvidencePicker';
type Form={formVersion?:2;boundary?:Boundary;farmerLabel:string;village:string;area:string;language:Onboarding['language'];district:string;plotLabel:string;landRight:Onboarding['landRight'];crop:string;season:Onboarding['season'];consent:boolean;step:number;eventId:string};
const empty=():Form=>({formVersion:2,farmerLabel:'',village:'',area:'',language:'en',district:'',plotLabel:'',landRight:'owner',crop:'',season:'kharif',consent:false,step:0,eventId:crypto.randomUUID()});
const steps=['Farmer','Plot & practice','Evidence','Consent & review'];
export function OnboardingForm({ownerId,onSaved,disabled}:{ownerId:string;onSaved:()=>Promise<void>;disabled:boolean}){
  const [form,setForm]=useState<Form|null>(null),[message,setMessage]=useState(''),[saving,setSaving]=useState(false);
  const writeQueue=useRef(Promise.resolve());
  const key=`onboarding:${ownerId}`;
  useEffect(()=>{let active=true;settings.get(key).then(saved=>{if(active){const value=saved?(saved.value as Form):empty();setForm({...value,formVersion:2,step:value.formVersion===2?value.step:Math.min(value.step,1)});}}).catch(()=>setMessage('Device storage is unavailable. Please free space and retry.'));return()=>{active=false;};},[key]);
  function change(next:Form){
    setForm(next);
    writeQueue.current=writeQueue.current.then(async()=>{await settings.put({key,value:next});setMessage('Draft saved on this device.');}).catch(()=>setMessage('Draft could not be saved. Keep this page open and free device storage.'));
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(!form)return;
    if(form.step===1){try{validateBoundary(form.boundary);}catch(error){setMessage(error instanceof Error?error.message:'Add a valid boundary.');return;}}
    if(form.step===2){const files=await evidence.where('eventId').equals(form.eventId).filter(item=>item.ownerId===ownerId).toArray();if(files.length!==2){setMessage('Save both synthetic evidence images before continuing.');return;}}
    if(form.step<3){change({...form,step:form.step+1});return;}
    setSaving(true);
    try{
      if(!form.consent)throw new Error('Consent is required before saving.');
      validateBoundary(form.boundary);
      if((await evidence.where('eventId').equals(form.eventId).filter(item=>item.ownerId===ownerId).count())!==2)throw new Error('Both evidence images are required.');
      await writeQueue.current;
      const onboarding:Onboarding={version:1,language:form.language,district:form.district.trim(),plotLabel:form.plotLabel.trim(),landRight:form.landRight,crop:form.crop.trim(),season:form.season,consentVersion:'demo-consent-v2',purpose:'demo-onboarding'};
      // Same event identity if saving fails after the capture is committed locally.
      await drafts.put({eventId:form.eventId,ownerId,farmerLabel:form.farmerLabel.trim(),village:form.village.trim(),areaHectares:Number(form.area).toFixed(2),consent:true,onboarding,boundary:form.boundary,state:'pending'});
      await settings.delete(key);setForm(empty());await onSaved();setMessage('Onboarding saved on this device. Sync when connected.');
    }catch(error){setMessage(error instanceof Error?error.message:'Save failed. Your draft is retained.');}finally{setSaving(false);}
  }
  if(!form)return <p role="status">{message||'Opening your saved draft…'}</p>;
  function field<K extends keyof Form>(name:K,value:Form[K]){if(form)change({...form,[name]:value});}
  return <><ol className="steps" aria-label="Onboarding progress">{steps.map((name,index)=><li key={name} aria-current={index===form.step?'step':undefined} className={index===form.step?'current':''}><span>{index+1}</span>{name}</li>)}</ol>
    <form onSubmit={submit}>
      <fieldset disabled={disabled||saving}><legend>{steps[form.step]}</legend>
        {form.step===0&&<>
          <label>Synthetic farmer label<input required maxLength={80} pattern=".*\S.*" value={form.farmerLabel} placeholder="Demo farmer 04" onChange={e=>field('farmerLabel',e.target.value)}/></label>
          <label>Preferred communication language<select value={form.language} onChange={e=>field('language',e.target.value as Form['language'])}><option value="en">English</option><option value="hi">Hindi</option><option value="bn">Bengali</option></select></label>
          <label>District label<input required maxLength={80} pattern=".*\S.*" value={form.district} placeholder="Nadia" onChange={e=>field('district',e.target.value)}/></label>
          <label>Village label<input required maxLength={80} pattern=".*\S.*" value={form.village} placeholder="Demo village" onChange={e=>field('village',e.target.value)}/></label>
        </>}
        {form.step===1&&<>
          <label>Plot label<input required maxLength={80} pattern=".*\S.*" value={form.plotLabel} placeholder="Demo plot A" onChange={e=>field('plotLabel',e.target.value)}/></label>
          <label>Declared plot area (hectares)<input required type="number" min="0.01" max="9999.99" step="0.01" value={form.area} onChange={e=>field('area',e.target.value)}/></label>
          <label>Claimed land right<select value={form.landRight} onChange={e=>field('landRight',e.target.value as Form['landRight'])}><option value="owner">Owner</option><option value="consented_cultivator">Cultivator with owner consent</option></select></label>
          <label>Crop / practice label<input required maxLength={80} pattern=".*\S.*" value={form.crop} placeholder="Demo rice crop" onChange={e=>field('crop',e.target.value)}/></label>
          <label>Season<select value={form.season} onChange={e=>field('season',e.target.value as Form['season'])}><option value="kharif">Kharif</option><option value="rabi">Rabi</option><option value="zaid">Zaid</option><option value="perennial">Perennial</option></select></label>
          <BoundaryEditor value={form.boundary} onChange={value=>field('boundary',value)}/>
          <p className="help">Declared area and rights remain unverified. The server calculates polygon area separately.</p>
        </>}
        {form.step===2&&<EvidencePicker ownerId={ownerId} eventId={form.eventId}/>}
        {form.step===3&&<>
          <dl className="review"><dt>Farmer</dt><dd>{form.farmerLabel} · {form.language.toUpperCase()}</dd><dt>Location</dt><dd>{form.village}, {form.district}</dd><dt>Plot</dt><dd>{form.plotLabel} · {Number(form.area).toFixed(2)} ha declared</dd><dt>Boundary</dt><dd>{form.boundary?validateBoundary(form.boundary).areaHectares:'Missing'} ha calculated</dd><dt>Right</dt><dd>{form.landRight==='owner'?'Owner':'Consented cultivator'} · unverified</dd><dt>Practice</dt><dd>{form.crop} · {form.season}</dd><dt>Evidence</dt><dd>Two synthetic images saved locally</dd></dl>
          <p className="help">Demo consent v2: store this invented farmer, plot boundary and synthetic proof images on this device and the GreenChain demo server for onboarding and evidence review. No real identity or payment verification is performed.</p>
          <label className="check"><input required type="checkbox" checked={form.consent} onChange={e=>field('consent',e.target.checked)}/>I confirm this is invented data and consent to its storage for demo onboarding.</label>
        </>}
        <div className="form-actions">{form.step>0&&<button type="button" className="secondary" onClick={()=>change({...form,step:form.step-1})}>Back</button>}<button type="submit">{saving?'Saving…':form.step===3?'Save case on this device':'Continue'}</button></div>
      </fieldset>
    </form><p className="status" role="status" aria-live="polite">{message}</p></>;
}
