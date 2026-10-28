'use client';
import {useEffect,useState} from 'react';
import {formatPaise,stateLabel} from './market';
import {CertificateView,type Certificate} from './CertificateView';
type Request=(path:string,options?:RequestInit)=>Promise<any>;
type Row={id:string;state:string;quantity:number;allocatedQuantity:number;payablePaise:string;payment:string|null;refundsPending:number;createdAt:string};
const OUTCOMES:{value:string;label:string;help:string}[]=[
  {value:'pending',label:'Payment pending',help:'The provider reports the payment as in progress; the reservation is extended (to at most 30 minutes).'},
  {value:'success',label:'Payment succeeds',help:'Captured: the credits become the buyer\'s.'},
  {value:'failure',label:'Payment fails',help:'Declined: the order stays payable until its reservation ends.'},
  {value:'replay',label:'Resend last callback',help:'The same callback again. Nothing changes: the ledger stays exactly as it was.'},
  {value:'double_charge',label:'Second charge',help:'Another checkout also captures money. The order is untouched and the second charge is refunded.'},
  {value:'late_success',label:'Late success',help:'Let the reservation expire, then the payment arrives. The same credits are re-reserved if still free; otherwise a full refund.'},
  {value:'refund',label:'Settle refunds',help:'The provider confirms all pending refunds in this scenario.'}];
/**
 * The presenter's controls for the simulated payment provider (demo mode only). Use it in a second window, signed in as the
 * presenter, while the buyer shops in the first. Hidden when the server has no demo mode.
 */
export function PresenterMarketPanel({request}:{request:Request}){
  const [available,setAvailable]=useState(true),[rows,setRows]=useState<Row[]>([]),[selected,setSelected]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [certificate,setCertificate]=useState<Certificate|null>(null);
  async function refresh(){const result=await request('/demo/orders');setRows(result.orders);}
  useEffect(()=>{refresh().catch(()=>setAvailable(false));},[]);
  if(!available)return null;
  async function run(outcome:string){
    if(!selected&&outcome!=='refund')return;setBusy(true);
    try{
      // Settling refunds is scenario-wide; any order id in the scenario will do for the route.
      const target=selected||rows[0]?.id;if(!target){setMessage('No orders yet.');return;}
      const result=await request(`/demo/orders/${target}/simulate`,{method:'POST',body:JSON.stringify({outcome})});
      setMessage(result.outcome?`Provider event applied: ${result.outcome.replaceAll('_',' ').toLowerCase()}${result.replayed?' (replayed, no change)':''}.`:`Refunds settled: ${result.settled}; orders closed: ${result.closed}.`);
      await refresh();
    }catch(error){setMessage(error instanceof Error?error.message:'The simulated provider call failed.');}finally{setBusy(false);}
  }
  const current=rows.find(r=>r.id===selected);
  return <section className="card presenter-market"><div className="card-heading"><h2>Simulated payment provider</h2><button className="text-button" disabled={busy} onClick={()=>refresh().catch(error=>setMessage(error.message))}>Refresh orders</button></div>
    <p>Presenter controls for the demo. Open the buyer account in a separate (private) window, place an order and start payment there, then choose what the provider does here. Every choice is delivered as a signed provider callback through the same handler a real provider would use.</p>
    <div className="case-list">{rows.map(r=><button type="button" className="case-row" key={r.id} disabled={busy} aria-pressed={r.id===selected} onClick={()=>setSelected(r.id)}>
      <strong>Order {r.id.slice(0,8).toUpperCase()} · {stateLabel(r.state)}</strong><span>{r.allocatedQuantity||r.quantity} credits · {formatPaise(r.payablePaise)} · payment {r.payment?r.payment.toLowerCase():'not started'}{r.refundsPending?` · ${r.refundsPending} refund pending`:''}</span></button>)}{!rows.length&&<p>No buyer orders yet.</p>}</div>
    {current&&<p className="help">Selected: order {current.id.slice(0,8).toUpperCase()}, {stateLabel(current.state).toLowerCase()}.</p>}
    {current?.state==='FULFILLED'&&<button type="button" className="secondary" disabled={busy} onClick={async()=>{setBusy(true);try{setCertificate((await request(`/demo/orders/${current.id}/certificate`,{method:'POST'})).certificate);}catch(error){setMessage(error instanceof Error?error.message:'Could not show the certificate.');}finally{setBusy(false);}}}>Show purchase certificate</button>}
    {certificate&&<CertificateView certificate={certificate} onClose={()=>setCertificate(null)}/>}
    <div className="outcome-grid">{OUTCOMES.map(o=><div key={o.value}><button className={o.value==='success'?'':'secondary'} disabled={busy||(!selected&&o.value!=='refund')} onClick={()=>run(o.value)}>{o.label}</button><p className="help">{o.help}</p></div>)}</div>
    <p role="status" aria-live="polite" className="status">{message}</p>
  </section>;
}
