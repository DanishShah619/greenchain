'use client';
import {useEffect,useState} from 'react';
import {DemoCalculationPanel} from './DemoCalculationPanel';
type Request=(path:string,options?:RequestInit)=>Promise<any>;
type Case={capture_id:string;farmer_label:string;village:string;state:string;version:number;complete_slots:number;has_boundary:boolean};
type Detail={case:{capture_id:string;farmer_label:string;village:string;state:string;version:number;declared_area:string;onboarding:{plotLabel:string;landRight:string;crop:string;season:string}};plot?:{area_hectares:string;boundary:{coordinates:number[][][]}};evidence:{id:string;slot:string;filename:string;status:string}[];missing:string[];decision?:{decision:string;reason:string;reviewer_id:string}};
function EvidencePreview({url}:{url:string}){
  const [src,setSrc]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let active=true,objectUrl='';fetch(url,{credentials:'include',cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error('Preview unavailable');objectUrl=URL.createObjectURL(await response.blob());if(active)setSrc(objectUrl);else URL.revokeObjectURL(objectUrl);}).catch(()=>{if(active)setError('Preview unavailable. Check your session.');});return()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};},[url]);
  return src?<img className="evidence-preview" src={src} alt="Synthetic case evidence"/>:<p>{error||'Loading proof…'}</p>;
}
export function VerifierWorkspace({request,api}:{request:Request;api:string}){
  const [cases,setCases]=useState<Case[]>([]),[detail,setDetail]=useState<Detail|null>(null),[reason,setReason]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [decisionId,setDecisionId]=useState('');
  async function refresh(){setCases((await request('/verification/cases')).cases);}
  useEffect(()=>{refresh().catch(error=>setMessage(error.message));},[]);
  async function open(id:string){setBusy(true);try{setDetail(await request(`/cases/${id}`));setReason('');setDecisionId(crypto.randomUUID());setMessage('');}catch(error){setMessage(error instanceof Error?error.message:'Could not load case');}finally{setBusy(false);}}
  async function decide(decision:'EVIDENCE_APPROVED'|'REJECTED'){
    if(!detail)return;setBusy(true);
    try{await request(`/verification/cases/${detail.case.capture_id}/decision`,{method:'POST',body:JSON.stringify({decisionId,expectedVersion:detail.case.version,decision,reason})});setDetail(await request(`/cases/${detail.case.capture_id}`));await refresh();setMessage('Evidence review recorded. No carbon credits have been issued.');}
    catch(error){setMessage(error instanceof Error?error.message:'Review failed. Refresh the case before retrying.');}finally{setBusy(false);}
  }
  return <section className="card verifier"><div className="card-heading"><h2>Verifier evidence queue</h2><button className="text-button" disabled={busy} onClick={()=>refresh().catch(error=>setMessage(error.message))}>Refresh queue</button></div><p>Review synthetic boundaries and both validated proof images. Approval covers evidence only; a reviewed carbon calculation is a later step.</p>
    <div className="case-list">{cases.map(item=><button type="button" className="case-row" key={item.capture_id} disabled={busy} onClick={()=>open(item.capture_id)}><strong>{item.farmer_label}</strong><span>{item.village} · {item.state.replaceAll('_',' ')} · {item.complete_slots}/2 proofs · {item.has_boundary?'Boundary saved':'Boundary missing'}</span></button>)}{!cases.length&&<p>No cases within your demo review mandate.</p>}</div>
    {detail&&<section className="case-detail"><h3>{detail.case.farmer_label} · {detail.case.onboarding?.plotLabel}</h3><dl className="review"><dt>Status</dt><dd>{detail.case.state.replaceAll('_',' ')}</dd><dt>Area</dt><dd>{detail.plot?.area_hectares??'Missing'} ha calculated · {detail.case.declared_area} ha declared</dd><dt>Right</dt><dd>{detail.case.onboarding?.landRight??'Missing'}</dd><dt>Practice</dt><dd>{detail.case.onboarding?.crop} · {detail.case.onboarding?.season}</dd></dl>
      {detail.plot&&<details><summary>Stored boundary coordinates</summary><pre>{JSON.stringify(detail.plot.boundary,null,2)}</pre></details>}
      {detail.missing.length>0&&<p className="notice">Missing: {detail.missing.join(', ')}. This case cannot be approved.</p>}
      <div className="proofs">{detail.evidence.map(item=><article key={item.id}><h3>{item.slot==='land_rights'?'Land-rights proof':'Plot photo'}</h3><p>{item.filename} · {item.status}</p>{item.status==='COMPLETE'&&<EvidencePreview url={`${api}/api/v1/uploads/${item.id}/preview`}/>}</article>)}</div>
      {detail.decision?<div className="notice">Recorded decision: {detail.decision.decision.replaceAll('_',' ')}<p>{detail.decision.reason}</p></div>:<><label>Review reason<textarea minLength={10} maxLength={500} rows={3} value={reason} onChange={event=>setReason(event.target.value)} placeholder="Explain your evidence review decision"/></label><div className="form-actions"><button disabled={busy||detail.case.state!=='SUBMITTED'||detail.missing.length>0||reason.trim().length<10} onClick={()=>decide('EVIDENCE_APPROVED')}>Approve demo evidence</button><button className="secondary" disabled={busy||detail.case.state!=='SUBMITTED'||reason.trim().length<10} onClick={()=>decide('REJECTED')}>Reject case</button></div></>}
      <DemoCalculationPanel key={detail.case.capture_id} caseId={detail.case.capture_id} request={request} canGenerate={false} canReview/>
    </section>}<p role="status" className="status">{message}</p>
  </section>;
}
