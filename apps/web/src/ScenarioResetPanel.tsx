'use client';
import {useEffect,useState,type FormEvent} from 'react';
import {resetConfirmed} from './certificates';
type Request=(path:string,options?:RequestInit)=>Promise<any>;
/**
 * The presenter's safe reset (docs/24 §2). Nothing is deleted: the accounts move to a fresh scenario seeded to the starting state,
 * the old one is kept and retired, and everyone signs in again. Needs the word RESET typed; hidden for anyone but the presenter.
 */
export function ScenarioResetPanel({request,onReset}:{request:Request;onReset:()=>void}){
  const [available,setAvailable]=useState(true),[open,setOpen]=useState(false),[typed,setTyped]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID());
  useEffect(()=>{request('/demo/orders').catch(()=>setAvailable(false));},[]);
  if(!available)return null;
  async function confirm(event:FormEvent){
    event.preventDefault();if(!resetConfirmed(typed))return;
    setBusy(true);
    try{
      const r=await request('/demo/reset',{method:'POST',body:JSON.stringify({requestId,confirm:'RESET'})});
      setMessage(`Reset done: a fresh scenario (${r.scenarioId}) is ready. Everyone signs in again.`);setRequestId(crypto.randomUUID());
      setTimeout(onReset,1500);
    }catch(error){setMessage(error instanceof Error?error.message:'The reset failed. Nothing was changed.');}finally{setBusy(false);}
  }
  return <section className="card reset-panel" aria-labelledby="reset-title">
    <div className="card-heading"><h2 id="reset-title">Reset the demo</h2></div>
    <p>Start the next rehearsal from the documented starting state: 20 farmer groups with 10 credits each, no orders, payouts or clock offset. Nothing is deleted. This run is kept, read-only, and every account signs in again.</p>
    {!open?<button type="button" className="secondary" onClick={()=>{setOpen(true);setTyped('');}}>Reset the demo…</button>
      :<form onSubmit={confirm}><label>Type RESET to confirm<input value={typed} autoComplete="off" spellCheck={false} onChange={event=>setTyped(event.target.value)}/></label>
        <div className="button-row"><button disabled={busy||!resetConfirmed(typed)}>Reset now</button><button type="button" className="secondary" disabled={busy} onClick={()=>setOpen(false)}>Keep this run</button></div></form>}
    <p role="status" aria-live="polite" className="status">{message}</p>
  </section>;
}
