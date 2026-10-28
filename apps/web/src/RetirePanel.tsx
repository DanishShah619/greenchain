'use client';
import {useEffect,useState,type FormEvent} from 'react';
import type {Certificate} from './CertificateView';
import {defaultReportingPeriod,RETIRE_MESSAGES,validPurpose,validReportingPeriod} from './retirements';
type Request=(path:string,options?:RequestInit)=>Promise<any>;
const message=(error:unknown,fallback:string)=>{const code=(error as {code?:string})?.code;return (code&&RETIRE_MESSAGES[code])||(error instanceof Error?error.message:fallback);};
/**
 * Retire credits of a paid order (docs/25 T1, T8): how many, for which reporting period, and an optional public purpose. The
 * server picks the oldest credit ids still held and answers with the frozen retirement certificate. The request id is kept until
 * the form changes, so a retry after a network failure can never retire twice.
 */
export function RetirePanel({request,orderId,held,online,onRetired}:{request:Request;orderId:string;held:number;online:boolean;onRetired:(certificate:Certificate)=>void}){
  const [countText,setCountText]=useState(String(held)),[period,setPeriod]=useState(()=>defaultReportingPeriod(new Date())),[purpose,setPurpose]=useState('');
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID()),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
  useEffect(()=>{setCountText(String(held));},[held]);
  const count=/^[0-9]{1,3}$/.test(countText)?Number(countText):NaN,countOk=Number.isInteger(count)&&count>=1&&count<=Math.min(held,100);
  const periodOk=validReportingPeriod(period),purposeOk=validPurpose(purpose);
  const edit=(set:(v:string)=>void)=>(value:string)=>{set(value);setRequestId(crypto.randomUUID());};
  if(held===0)return <p className="notice">Every credit of this order is retired.</p>;
  async function retire(event:FormEvent){
    event.preventDefault();if(!countOk||!periodOk||!purposeOk)return;setBusy(true);setStatus('');
    try{
      const result=await request(`/orders/${orderId}/retirements`,{method:'POST',body:JSON.stringify({requestId,count,reportingPeriod:period,...(purpose?{purpose}:{})})});
      setRequestId(crypto.randomUUID());setPurpose('');
      setStatus(`Retired ${result.retirement.creditCount} credit${result.retirement.creditCount===1?'':'s'} for ${result.retirement.reportingPeriod}.`);
      onRetired(result.certificate);
    }catch(error){setStatus(message(error,'The credits were not retired. You can retry safely.'));}finally{setBusy(false);}
  }
  return <form className="retire-form" onSubmit={retire} aria-labelledby={`retire-${orderId}`}>
    <h4 id={`retire-${orderId}`}>Retire credits</h4>
    <p className="help">Retiring claims these credits against your own emissions. It is final: a retired credit cannot be sold or retired again.</p>
    <label>Credits to retire (of {held} still held)<input type="number" min={1} max={Math.min(held,100)} step={1} inputMode="numeric" required aria-invalid={!countOk} value={countText} onChange={event=>edit(setCountText)(event.target.value)}/></label>
    <label>Reporting period<input value={period} required aria-invalid={!periodOk} aria-describedby={`period-help-${orderId}`} autoComplete="off" spellCheck={false} onChange={event=>edit(setPeriod)(event.target.value.trim().toUpperCase())}/></label>
    <p className="help" id={`period-help-${orderId}`}>A financial year such as FY2026-27, or a calendar year such as 2026.</p>
    <label>Purpose (optional)<input value={purpose} maxLength={120} aria-invalid={!purposeOk} aria-describedby={`purpose-help-${orderId}`} onChange={event=>edit(setPurpose)(event.target.value)}/></label>
    <p className="help" id={`purpose-help-${orderId}`}>Shown publicly on the retirement certificate. Up to 120 letters, digits and basic punctuation.</p>
    <button disabled={busy||!online||!countOk||!periodOk||!purposeOk}>{countOk?`Retire ${count} credit${count===1?'':'s'}`:'Enter how many to retire'}</button>
    <p role="status" aria-live="polite" className="status">{status}</p>
  </form>;
}
type Summary={retirements:{id:string;creditCount:number;reportingPeriod:string;purpose:string|null;createdAt:string;certificateNumber:string}[];totals:{purchased:number;retired:number;held:number}};
/** The buyer's purchased, retired and still-held totals (backlog S9.6, minimal) and its retirement certificates. */
export function RetirementSummary({request,version,onOpen}:{request:Request;version:number;onOpen:(certificate:Certificate)=>void}){
  const [summary,setSummary]=useState<Summary|null>(null),[status,setStatus]=useState('');
  useEffect(()=>{request('/retirements').then(setSummary).catch(()=>setSummary(null));},[version]);
  if(!summary||summary.totals.purchased===0)return null;
  async function open(id:string){try{onOpen((await request(`/retirements/${id}/certificate`)).certificate);setStatus('');}catch(error){setStatus(message(error,'Could not open the certificate.'));}}
  return <section className="retirement-summary" aria-labelledby="retirement-summary-title">
    <h3 id="retirement-summary-title" className="section-title">Your credits</h3>
    <dl className="market-summary"><div><dt>Purchased</dt><dd>{summary.totals.purchased}</dd></div><div><dt>Retired</dt><dd>{summary.totals.retired}</dd></div><div><dt>Still held</dt><dd>{summary.totals.held}</dd></div></dl>
    {summary.retirements.length>0&&<ul className="group-list">{summary.retirements.map(r=><li key={r.id}><strong>{r.creditCount} credit{r.creditCount===1?'':'s'} · {r.reportingPeriod}</strong>
      <span>{r.purpose??'No purpose given'} · {new Date(r.createdAt).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'})}</span>
      <button type="button" className="text-button" onClick={()=>open(r.id)}>View certificate {r.certificateNumber}</button></li>)}</ul>}
    <p role="status" aria-live="polite" className="status">{status}</p>
  </section>;
}
