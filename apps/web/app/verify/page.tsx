'use client';
import {useEffect,useState,type FormEvent} from 'react';
import {formatPaise} from '../../src/market';
import {CERTIFICATE_MESSAGES,isCertificateNumber,verifyQuery} from '../../src/certificates';
const API=process.env.NEXT_PUBLIC_API_URL??'http://localhost:4000';
type Result={number:string;contentSha256:string;issuedAt:string;intact:boolean;hashMatches?:boolean;content:{label:string;order:{quantity:number;payablePaise:string};groups:{group:string;credits:number}[]}};
/**
 * Public certificate verification (docs/24 C5). Anyone with a certificate can check that it exists, that its stored content is
 * intact, and that the fingerprint printed on it matches. No sign-in; the buyer account is not shown.
 */
export default function Verify(){
  const [number,setNumber]=useState(''),[hash,setHash]=useState<string|null>(null),[result,setResult]=useState<Result|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  async function check(n:string,h:string|null){
    setBusy(true);setResult(null);setMessage('');
    try{
      const response=await fetch(`${API}/api/v1/certificates/${encodeURIComponent(n)}${h?`?hash=${h}`:''}`,{signal:AbortSignal.timeout(8000)});
      const body=await response.json();
      if(!response.ok)setMessage(CERTIFICATE_MESSAGES[body.code]??'The certificate could not be checked.');else setResult(body);
    }catch{setMessage('The verification service could not be reached. Try again later.');}finally{setBusy(false);}
  }
  useEffect(()=>{const q=verifyQuery(window.location.search);setHash(q.hash);if(q.number){setNumber(q.number);check(q.number,q.hash);}},[]);
  function submit(event:FormEvent){event.preventDefault();const n=number.trim().toUpperCase();if(isCertificateNumber(n))check(n,hash);else setMessage('A certificate number looks like GC-DEMO-XXXX-XXXX.');}
  const verdict=result&&(!result.intact?'This certificate record has been altered. Do not rely on it.':result.hashMatches===false?'The fingerprint does not match: this copy differs from the issued certificate.':
    result.hashMatches?'Genuine: this copy matches the issued certificate exactly.':'This certificate exists and its record is intact.');
  return <main className="verify-page"><a className="brand" href="/">◈ GreenChain</a>
    <h1>Check a certificate</h1>
    <p className="notice">Demonstration certificates record synthetic demo credits and simulated payments. They are not recognised carbon credits.</p>
    <form onSubmit={submit}><label>Certificate number<input value={number} onChange={event=>setNumber(event.target.value)} placeholder="GC-DEMO-XXXX-XXXX" autoCapitalize="characters"/></label><button disabled={busy}>Check</button></form>
    {result&&<section className="card" aria-live="polite"><h2>{verdict}</h2>
      <dl className="certificate-facts"><dt>Certificate</dt><dd>{result.number}</dd><dt>Issued</dt><dd>{new Date(result.issuedAt).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'})}</dd>
        <dt>Credits</dt><dd>{result.content.order.quantity} demo credits · total {formatPaise(result.content.order.payablePaise)}</dd>
        <dt>Farmer groups</dt><dd>{result.content.groups.map(g=>`${g.group} (${g.credits})`).join(', ')}</dd></dl>
      <p className="fingerprint">Fingerprint: <code>{result.contentSha256}</code></p></section>}
    <p role="status" aria-live="polite" className="status">{message}</p>
  </main>;
}
