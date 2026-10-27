'use client';
import {useEffect,useState,type FormEvent} from 'react';
import {formatPaise} from './market';
import {batchMessage,bpsToPercent,clockLabel,inFlight,labelCode,paiseToRupeesInput,payoutStateLabel,percentToBps,rupeesToPaise,SANDBOX_CHOICES} from './payouts';
type Request=(path:string,options?:RequestInit)=>Promise<any>;
type Payee={label:string;suffix:string;reverifyRequired:boolean;payablePaise:string;heldPaise:string;paidPaise:string};
type Payout={id:string;payee:string;state:string;amountPaise:string;attempts:number;flags:string[];cancellable:boolean;createdAt:string};
type Panel={clock:{offsetSeconds:number;simulatedNow:string};config:{version:number;holdbackDays:number;reserveBps:number;minPayoutPaise:string;payoutLimitPaise:string};
  payees:Payee[];batches:{runDate:string;runSeq:number;status:string;createdBy:string;payouts:number}[];payouts:Payout[]};
const STEPS=[{seconds:86400,label:'+1 day'},{seconds:7*86400,label:'+7 days'},{seconds:30*86400,label:'+30 days'}];
const FLAGS:Record<string,string>={AMOUNT_MISMATCH:'bank paid a different amount',ATTEMPTS_EXHAUSTED:'six attempts used',OVERSIZED_LOT_SKIPPED:'a sale above the limit was left out',
  SENT_NOT_FOUND:'bank lost track of it',RAIL_KEY_CONFLICT:'bank saw different details',PROCESSED_AFTER_CONFIRMATION:'bank paid after confirming it had not'};
/**
 * The presenter's payout controls (docs/23 §6.4): the demo clock, payout rules, payout runs, each farmer group's simulated bank
 * behaviour, and cancelling a payout the bank confirmed it never paid. Hidden for anyone who is not the presenter, and outside
 * demo mode. Farmer groups appear by label only.
 */
export function PresenterPayoutPanel({request}:{request:Request}){
  const [panel,setPanel]=useState<Panel|null>(null),[available,setAvailable]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [batchRequest,setBatchRequest]=useState(()=>crypto.randomUUID());
  const [config,setConfig]=useState({holdbackDays:'',reservePercent:'',min:'',limit:''});
  const [cancelling,setCancelling]=useState<{id:string;reason:string;requestId:string}|null>(null);
  async function refresh(){
    const next:Panel=await request('/demo/payouts');setPanel(next);
    setConfig(c=>c.holdbackDays===''?{holdbackDays:String(next.config.holdbackDays),reservePercent:bpsToPercent(next.config.reserveBps).replace('%',''),
      min:paiseToRupeesInput(next.config.minPayoutPaise),limit:paiseToRupeesInput(next.config.payoutLimitPaise)}:c);
  }
  useEffect(()=>{refresh().catch(()=>setAvailable(false));},[]);
  // The worker moves payouts on its own; refresh while any are still in flight.
  useEffect(()=>{if(!panel||!inFlight(panel.payouts))return;const poll=setInterval(()=>{refresh().catch(()=>{});},3000);return()=>clearInterval(poll);},[panel]);
  if(!available)return null;
  async function act(work:()=>Promise<string>){
    setBusy(true);
    try{setMessage(await work());await refresh();}
    catch(error){setMessage(error instanceof Error?error.message:'The request failed.');await refresh().catch(()=>{});}
    finally{setBusy(false);}
  }
  const advance=(seconds:number)=>act(async()=>{
    const moved=await request('/demo/clock',{method:'POST',body:JSON.stringify({expectedOffsetSeconds:panel!.clock.offsetSeconds,advanceSeconds:seconds})});
    return `Demo clock is now ${clockLabel(moved.offsetSeconds).toLowerCase()}.`;
  });
  const runBatch=()=>act(async()=>{
    const r=await request('/demo/payouts/batch',{method:'POST',body:JSON.stringify({requestId:batchRequest})});
    setBatchRequest(crypto.randomUUID());
    return batchMessage(r);
  });
  function saveConfig(event:FormEvent){
    event.preventDefault();
    const holdbackDays=Number(config.holdbackDays),reserveBps=percentToBps(config.reservePercent),min=rupeesToPaise(config.min),limit=rupeesToPaise(config.limit);
    if(!Number.isInteger(holdbackDays)||holdbackDays<0||holdbackDays>365||reserveBps===null||!min||!limit||BigInt(min)>BigInt(limit)){
      setMessage('Check the rules: holdback 0–365 days, reserve 0–100%, and a positive minimum no larger than the limit.');return;
    }
    act(async()=>{const r=await request('/demo/ledger-config',{method:'PUT',body:JSON.stringify({holdbackDays,reserveBps,minPayoutPaise:min,payoutLimitPaise:limit})});
      return `Payout rules version ${r.version} apply to sales and runs from now on.`;});
  }
  const setSuffix=(label:string,suffix:string)=>act(async()=>{
    await request(`/demo/payees/${labelCode(label)}/sandbox`,{method:'POST',body:JSON.stringify({suffix})});
    return `${label} now uses bank behaviour ${suffix}; any re-verification hold is cleared.`;
  });
  function confirmCancel(event:FormEvent){
    event.preventDefault();if(!cancelling)return;
    const target=cancelling;
    act(async()=>{await request(`/demo/payouts/${target.id}/cancel`,{method:'POST',body:JSON.stringify({requestId:target.requestId,reason:target.reason})});
      setCancelling(null);return 'Payout cancelled. Its sales are payable again and will go in a later run.';});
  }
  if(!panel)return <section className="card payout-panel"><p role="status">Loading payout controls…</p></section>;
  return <section className="card payout-panel" aria-labelledby="payout-panel-title">
    <div className="card-heading"><h2 id="payout-panel-title">Farmer payouts</h2><button className="text-button" disabled={busy} onClick={()=>refresh().catch(error=>setMessage(error.message))}>Refresh</button></div>
    <p>Presenter controls. Sales are paid to farmer groups in payout runs, through a simulated bank. Move the demo clock to pass the 7-day holdback, then run a payout; the worker sends and settles it within seconds.</p>
    <div className="clock-row"><div><span>Demo clock</span><strong>{clockLabel(panel.clock.offsetSeconds)}</strong><small>{new Date(panel.clock.simulatedNow).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</small></div>
      <div className="button-row">{STEPS.map(s=><button key={s.seconds} type="button" className="secondary" disabled={busy} onClick={()=>advance(s.seconds)}>{s.label}</button>)}</div></div>
    <button type="button" disabled={busy} onClick={runBatch}>Run payouts now</button>
    <h3>Farmer groups</h3>
    {panel.payees.length?<div className="table-scroll"><table><caption>Earnings by farmer group</caption>
      <thead><tr><th scope="col">Group</th><th scope="col">Not yet paid</th><th scope="col">Of which held</th><th scope="col">Paid</th><th scope="col">Simulated bank</th></tr></thead>
      <tbody>{panel.payees.map(p=><tr key={p.label}><th scope="row">{p.label}{p.reverifyRequired&&<span className="pill warn">Re-verify</span>}</th><td>{formatPaise(p.payablePaise)}</td><td>{formatPaise(p.heldPaise)}</td><td>{formatPaise(p.paidPaise)}</td>
        <td><label className="sr-only" htmlFor={`suffix-${p.label}`}>Bank behaviour for {p.label}</label><select id={`suffix-${p.label}`} value={p.suffix} disabled={busy} onChange={event=>setSuffix(p.label,event.target.value)}>
          {SANDBOX_CHOICES.map(c=><option key={c.suffix} value={c.suffix}>{c.suffix} · {c.label}</option>)}</select></td></tr>)}</tbody></table></div>
      :<p>No farmer group has earned anything yet. Sell some credits first.</p>}
    <h3>Payouts</h3>
    {panel.payouts.length?<ul className="payout-list">{panel.payouts.map(p=><li key={p.id}>
      <div><strong>{p.payee} · {formatPaise(p.amountPaise)}</strong><span>{payoutStateLabel(p.state)}{p.attempts>1?` · attempt ${p.attempts}`:''}{p.flags.length?` · ${p.flags.map(f=>FLAGS[f]??f.toLowerCase()).join(', ')}`:''}</span></div>
      {p.cancellable&&<button type="button" className="text-button" disabled={busy} onClick={()=>setCancelling({id:p.id,reason:'',requestId:crypto.randomUUID()})}>Cancel payout</button>}
      {cancelling?.id===p.id&&<form onSubmit={confirmCancel} className="cancel-form"><label>Why is it being cancelled?<input required minLength={3} maxLength={200} value={cancelling.reason} onChange={event=>setCancelling({...cancelling,reason:event.target.value})}/></label>
        <div className="button-row"><button disabled={busy}>Confirm cancel</button><button type="button" className="secondary" onClick={()=>setCancelling(null)}>Keep it</button></div></form>}
    </li>)}</ul>:<p>No payouts yet.</p>}
    <details><summary>Payout rules (version {panel.config.version}{panel.config.version===0?', defaults':''})</summary>
      <form onSubmit={saveConfig} className="rules-form">
        <label>Holdback for a group's first payout (days)<input inputMode="numeric" value={config.holdbackDays} onChange={e=>setConfig({...config,holdbackDays:e.target.value})}/></label>
        <label>Share of commission set aside as reserve (%)<input inputMode="decimal" value={config.reservePercent} onChange={e=>setConfig({...config,reservePercent:e.target.value})}/></label>
        <label>Minimum payout (₹)<input inputMode="decimal" value={config.min} onChange={e=>setConfig({...config,min:e.target.value})}/></label>
        <label>Largest payout (₹)<input inputMode="decimal" value={config.limit} onChange={e=>setConfig({...config,limit:e.target.value})}/></label>
        <button disabled={busy}>Save rules</button>
      </form></details>
    {!!panel.batches.length&&<details><summary>Recent payout runs ({panel.batches.length})</summary><ul>{panel.batches.map(b=><li key={`${b.runDate}-${b.runSeq}`}>
      {b.runDate} · run {b.runSeq} ({b.createdBy}) · {b.payouts} payout{b.payouts===1?'':'s'} · {b.status.toLowerCase()}</li>)}</ul></details>}
    <p role="status" aria-live="polite" className="status">{message}</p>
  </section>;
}
