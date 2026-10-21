'use client';
import {useEffect,useState,type FormEvent} from 'react';
import {drafts,settings,syncDrafts,syncEvidence,type Draft} from '../src/outbox';
import {OnboardingForm} from '../src/OnboardingForm';
import {PwaControls} from '../src/PwaControls';
import {VerifierWorkspace} from '../src/VerifierWorkspace';
import {DemoCalculationPanel} from '../src/DemoCalculationPanel';
import {BuyerWorkspace} from '../src/BuyerWorkspace';
import {PresenterMarketPanel} from '../src/PresenterMarketPanel';
import {MARKET_MESSAGES} from '../src/market';
type Capture={event_id?:string;farmer_label:string;village:string;area_hectares:string;status:string;review_state?:string;calculated_area?:string};
const API=process.env.NEXT_PUBLIC_API_URL??'http://localhost:4000';
const explanations:Record<string,string>={INVALID_CREDENTIALS:'The password was not accepted. Please try again.',LOGIN_REQUIRED:'Sign in again to sync. Your device records are retained.',CSRF_FAILED:'Your session changed. Sign in again before syncing.',RATE_LIMITED:'Too many login attempts. Please wait 15 minutes.',KEY_REUSE:'This capture or evidence ID has conflicting details. It needs review.',INVALID_INPUT:'Some capture details were rejected. Your device record is retained.',ACCOUNT_CHANGED:'The signed-in account differs from the owner of these device records.',INVALID_BOUNDARY:'The boundary is invalid. Check ring closure, coordinates and crossing edges.',INVALID_IMAGE:'An evidence image failed validation. Use a valid synthetic PNG or JPEG.',HASH_MISMATCH:'The uploaded image hash did not match. The evidence remains unvalidated.',MISSING_EVIDENCE:'A valid boundary and both complete proof images are required.',CASE_LOCKED:'This submitted case is locked. Corrections require a new case.',VERSION_CONFLICT:'The case changed. Refresh before retrying.',CASE_NOT_SUBMITTED:'Only submitted cases can be reviewed.',NOT_FOUND:'This case or proof is not available in your workspace.',FORBIDDEN:'Your account cannot perform this action.',SELF_REVIEW:'You cannot approve your own capture.'};
class ApiError extends Error{constructor(public code:string){super(explanations[code]??code);}}
Object.assign(explanations,{EVIDENCE_NOT_APPROVED:'Complete evidence approval before calculating.',STALE_EVIDENCE:'The evidence no longer matches its approved snapshot. Calculation is blocked.',DEMO_SCOPE_ONLY:'Synthetic calculations are allowed only in the demo namespace.'});
Object.assign(explanations,{STALE_CALCULATION:'A newer calculation is the current candidate. Refresh before reviewing.',CALCULATION_LOCKED:'This case already has an approved issuance basis.',ALREADY_ISSUED:'The case already has a demo issuance batch.',CALCULATION_ALREADY_REVIEWED:'This calculation already has a recorded decision.',VISIT_REQUIRED:'A Needs visit outcome cannot be approved for issuance.',ISSUANCE_BASIS_REQUIRED:'An exact approved calculation basis is required.'});
Object.assign(explanations,{AUDIT_INTEGRITY_FAILURE:'The audit integrity check failed. Ask the demo administrator to inspect the history.',AUDIT_ANCHOR_MISMATCH:'A recorded blockchain anchor differs from the audit history. Administrator review is required.',AUDIT_VERIFICATION_LIMIT:'The audit history needs a larger verification service. Ask the demo administrator.'});
Object.assign(explanations,MARKET_MESSAGES);
export default function Home(){
  const [actorId,setActorId]=useState(''),[csrf,setCsrf]=useState(''),[password,setPassword]=useState(''),[showPassword,setShowPassword]=useState(false);
  const [role,setRole]=useState('agent'),[account,setAccount]=useState('presenter');
  const [calculationCase,setCalculationCase]=useState('');
  const [records,setRecords]=useState<Capture[]>([]),[local,setLocal]=useState<Draft[]>([]);
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[online,setOnline]=useState(true),[storageReady,setStorageReady]=useState(false),[sessionReady,setSessionReady]=useState(false);
  async function request(path:string,options:RequestInit={}){
    const response=await fetch(`${API}/api/v1${path}`,{signal:AbortSignal.timeout(8000),...options,credentials:'include',headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...options.headers}});
    const value=response.status===204?{}:await response.json();
    if(!response.ok)throw new ApiError(value.code??'REQUEST_FAILED');
    return value;
  }
  async function refreshLocal(owner:string){setLocal(owner?await drafts.where('ownerId').equals(owner).toArray():[]);}
  async function remember(owner:string,workspaceRole='agent'){
    try{await settings.put({key:'active-presenter',value:{actorId:owner,role:workspaceRole}});await refreshLocal(workspaceRole==='agent'?owner:'');}
    catch{setStorageReady(false);setMessage('Device storage is unavailable. Free space before saving offline.');}
  }
  async function refreshRecords(authenticated:boolean,workspaceRole='agent'){if(authenticated&&workspaceRole!=='agent'){setRecords([]);return;}const result=await request(authenticated?'/captures':'/showcase');setRecords(result.captures);}
  useEffect(()=>{
    let active=true;
    setOnline(navigator.onLine);
    const update=()=>setOnline(navigator.onLine);
    window.addEventListener('online',update);window.addEventListener('offline',update);
    (async()=>{
      let remembered='';
      try{
        const saved=(await settings.get('active-presenter'))?.value as {actorId?:string;role?:string}|undefined;
        remembered=typeof saved?.actorId==='string'?saved.actorId:'';
        if(active){setStorageReady(true);if(remembered){setActorId(remembered);setRole(saved?.role??'agent');await refreshLocal(saved?.role&&saved.role!=='agent'?'':remembered);}}
      }catch{if(active)setMessage('Device storage is unavailable. Captures cannot be saved.');}
      try{
        const session=await request('/session');
        if(!active)return;
        setActorId(session.actorId);setRole(session.role);setCsrf(session.csrf);await remember(session.actorId,session.role);await refreshRecords(true,session.role);
      }catch(error){
        if(!active)return;
        if(remembered)setMessage(error instanceof ApiError?error.message:'Offline workspace restored. Sign in when connected to sync.');
        try{await refreshRecords(false);}catch{if(!remembered)setMessage('Connect once and sign in to prepare this device for offline onboarding.');}
      }finally{if(active)setSessionReady(true);}
    })();
    return()=>{active=false;window.removeEventListener('online',update);window.removeEventListener('offline',update);};
  },[]);
  async function login(event:FormEvent){
    event.preventDefault();setBusy(true);
    try{const result=await request('/session',{method:'POST',body:JSON.stringify({password,account})});setActorId(result.actorId);setRole(result.role);setCsrf(result.csrf);setPassword('');await remember(result.actorId,result.role);await refreshRecords(true,result.role);setMessage(result.role==='verifier'?'Verifier workspace ready.':result.role==='buyer'?'Buyer marketplace ready. All credits and payments are simulated.':'Agent workspace ready, including offline capture.');}
    catch(error){setMessage(error instanceof Error?error.message:'Login failed');}finally{setBusy(false);}
  }
  async function saved(){await refreshLocal(actorId);setMessage('Saved on this device. Sync to store the onboarding record on the server.');}
  async function sync(){
    setBusy(true);let accepted=0,rejected=0;
    try{
      const session=await request('/session');
      if(session.actorId!==actorId)throw new ApiError('ACCOUNT_CHANGED');
      setCsrf(session.csrf);
      const call=(path:string,options:RequestInit={})=>request(path,{...options,headers:{...options.headers,'X-CSRF-Token':session.csrf}});
      const result=await syncDrafts(actorId,async payload=>{
        const {boundary,...metadata}=payload;
        const ack=await call('/captures',{method:'POST',body:JSON.stringify(metadata)});
        if(boundary){
          const current=await call(`/cases/${payload.eventId}`);
          if(current.case.state==='DRAFT'){
            await call(`/cases/${payload.eventId}/boundary`,{method:'PUT',body:JSON.stringify({requestId:payload.eventId,expectedVersion:current.case.version,boundary})});
            await syncEvidence(actorId,payload.eventId,call);
            const latest=await call(`/cases/${payload.eventId}`);
            await call(`/cases/${payload.eventId}/submit`,{method:'POST',body:JSON.stringify({expectedVersion:latest.case.version})});
          }
        }
        return ack;
      });
      accepted=result.accepted;rejected=result.rejected;
      await refreshRecords(true);setMessage(`Server acknowledged ${accepted} capture${accepted===1?'':'s'}.${rejected?` ${rejected} rejected record(s) retained for review.`:''}`);
    }catch(error){
      if(error instanceof ApiError&&['LOGIN_REQUIRED','CSRF_FAILED'].includes(error.code))setCsrf('');
      setMessage(error instanceof ApiError?error.message:'Sync interrupted. Acknowledged records are saved; remaining records are retained. Retry when connected.');
    }finally{try{await refreshLocal(actorId);}finally{setBusy(false);}}
  }
  async function logout(){
    setBusy(true);
    try{
      await request('/session',{method:'DELETE'});
      await settings.delete('active-presenter');setCsrf('');setActorId('');setRole('agent');setLocal([]);setRecords([]);setCalculationCase('');
      setMessage('Signed out. Saved device records and drafts are retained for your next login.');
      try{await refreshRecords(false);}catch{}
    }catch(error){setMessage(error instanceof Error?error.message:'Sign out failed. Reconnect and retry.');}finally{setBusy(false);}
  }
  const pending=local.filter(item=>item.state==='pending').length;
  const loginForm=<><p>Use the separate seeded agent, verifier and buyer accounts. Phone OTP is not enabled in this demo.</p><form onSubmit={login}><label>Workspace account<select value={account} onChange={event=>setAccount(event.target.value)}><option value="presenter">Field agent / presenter</option><option value="verifier">Institution verifier</option><option value="buyer">Company buyer</option></select></label><label>Account password<div className="password-row"><input type={showPassword?'text':'password'} autoComplete="current-password" required maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/><button type="button" className="text-button" aria-pressed={showPassword} onClick={()=>setShowPassword(!showPassword)}>{showPassword?'Hide':'Show'}</button></div></label><button disabled={busy||!online||!sessionReady}>{busy?'Please wait…':'Sign in'}</button></form></>;
  return <div className="shell"><aside><a className="brand" href="/">◈ GreenChain</a><p className="tagline">Climate action. Shared prosperity.</p><div className="nav"><span className="active">◎ {role==='verifier'?'Verification workspace':role==='buyer'?'Buyer marketplace':'Field workspace'}</span><span>◌ Evidence review</span><span>◌ Marketplace</span><span>◌ Earnings · next</span></div><div className="aside-note">Built around farmers.<br/>Grounded in trust.</div></aside>
    <main><header><span>WORKSPACE / ONBOARDING</span><span className="badge">SYNTHETIC DEMO</span></header>
      <section className="hero"><div>{role==='buyer'?<><p className="eyebrow">THE MARKETPLACE</p><h1>Every credit traced back to a field.</h1><p>Reserve demo credits, see which farmer groups they come from and why, and pay through a simulated provider.</p></>:<><p className="eyebrow">THE FIRST MILE</p><h1>A better future starts in the field.</h1><p>Guide a farmer through the first step. Save the details on your device, then sync when you reconnect.</p></>}<div className="connection"><i className={online?'online':'offline'}/>{online?'Device online':'Device offline'} · {csrf?(role==='buyer'?'Signed-in buyer':role==='verifier'?'Signed-in verifier':'Signed-in presenter'):actorId?'Local presenter workspace':'Public showcase'}</div></div><div className="land-art" aria-hidden="true"><div className="sun"/><div className="field one"/><div className="field two"/><div className="field three"/><span>Every plot has a story.</span></div></section>
      <div className="notice">Demonstration only. Use invented farmer labels and locations. No recognised carbon credits, real payments, or identity documents.</div><PwaControls/>
      {role!=='buyer'&&<section className="stats" aria-label="Workspace counts"><div><span>Server captures · latest 50</span><strong>{records.length}</strong><small>{csrf?'Your presenter scenario':'Read-only showcase'}</small></div><div><span>Waiting to sync</span><strong>{pending}</strong><small>Saved on this device</small></div><div><span>Journey stage</span><strong className="stage">Farmer onboarding</strong><small>Identity, land rights and evidence remain unverified</small></div></section>}
      <div className="workspace"><section className="card"><div className="card-heading"><h2>{actorId?(role==='verifier'?'Institution reviewer':role==='buyer'?'Company buyer':'Onboard a demo farmer'):'Sign in'}</h2><span>01</span></div>
        {!sessionReady&&<p role="status">Restoring this device and checking your session…</p>}
        {!actorId?loginForm:role==='buyer'?<><p>Buying needs a connected, signed-in session. Orders and payments are never saved on this device for later.</p>{!csrf&&loginForm}{csrf&&<button className="text-button" disabled={busy||!online} onClick={logout}>Sign out</button>}</>:role==='verifier'?<><p>Institution review requires a connected, authenticated session.</p>{!csrf&&loginForm}{csrf&&<button className="text-button" disabled={busy||!online} onClick={logout}>Sign out</button>}</>:<><p>Your progress and proof images are saved on this device. Sync submits the completed case for review.</p><OnboardingForm key={actorId} ownerId={actorId} onSaved={saved} disabled={busy||!storageReady}/><button className="secondary" disabled={busy||!online||pending===0||!csrf} onClick={sync}>Sync pending captures ({pending})</button>{!csrf&&<details open><summary>Sign in to sync your saved records</summary>{loginForm}</details>}{csrf&&<button className="text-button" disabled={busy||!online} onClick={logout}>Sign out</button>}</>}
        <p role="status" aria-live="polite" className="status">{message}</p></section>
        {role==='verifier'&&csrf?<VerifierWorkspace request={request} api={API}/>:role==='buyer'&&csrf?<BuyerWorkspace request={request} online={online}/>:<section className="card"><div className="card-heading"><h2>{csrf?'Your synced plots':'A look at the field'}</h2><span className="subtle">{csrf?'PRIVATE SCENARIO':'READ ONLY'}</span></div><p>Onboarding records are declarations. Evidence review is distinct from carbon verification.</p>
          <div className="records">{records.map((record,index)=><article key={record.event_id??index}><div className="plot-icon">▧</div><div><h3>{record.farmer_label}</h3><p>{record.village} · {record.calculated_area??record.area_hectares} ha {record.calculated_area?'calculated':'declared'}</p>{csrf&&record.event_id&&<button className="text-button" onClick={()=>setCalculationCase(record.event_id!)}>Demo calculation</button>}</div><span className="pill">{record.review_state?.replaceAll('_',' ')??'Captured'}</span></article>)}{!records.length&&<p>No server captures to show. Device records remain available below.</p>}</div>
          {csrf&&calculationCase&&<DemoCalculationPanel key={calculationCase} caseId={calculationCase} request={request} canGenerate={role==='agent'}/>}
          {!!local.length&&<details open><summary>Your device records ({local.length})</summary><ul>{local.map(item=><li key={item.eventId}><strong>{item.farmerLabel}</strong> — {item.state==='synced'?'Server acknowledged':item.state==='pending'?'Waiting to sync':'Needs review'}{item.onboarding&&<span> · {item.onboarding.plotLabel} · {item.onboarding.crop}</span>}{item.error&&<p className="help">{item.error}</p>}</li>)}</ul></details>}
          <div className="next-step"><span>UP NEXT</span><h3>Track the credit journey</h3><p>Audit proofs and buyer allocation will connect issued demo units to their next stage.</p></div>
        </section>}</div>{csrf&&role==='agent'&&<PresenterMarketPanel request={request}/>}<footer>GreenChain · PWA field capture and review <span>All data in this workspace is synthetic.</span></footer>
    </main></div>;
}
