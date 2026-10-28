'use client';
import {formatPaise} from './market';
import {proofLine,verifyLink,type Proof} from './certificates';
type Credits={credits:{id:string;tonnes:string;vintage:number;group:string}[];groups:{group:string;credits:number}[]};
type PurchaseContent=Credits&{kind?:undefined;label:string;number:string;issuedAt:string;buyer:{account:string};
  order:{fulfilledAt:string;quantity:number;unitPricePaise:string;grossPaise:string;taxPaise:string;taxRule:string;payablePaise:string;currency:string};proofs:Proof[]};
type RetirementContent=Credits&{kind:'RETIREMENT';label:string;number:string;issuedAt:string;buyer:{account:string};reportingPeriod:string;purpose:string|null;quantity:number;purchaseCertificates:string[]};
export type Certificate={number:string;contentSha256:string;issuedAt:string;content:PurchaseContent|RetirementContent};
const DATE=new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Kolkata'});
/**
 * A purchase certificate (docs/24 C3-C4) or a retirement certificate (docs/25 T4), ready to print: the browser's "Save as PDF" turns it into a file. Everything shown
 * comes from the frozen certificate content; the hash and the verification link let anyone check it was not altered.
 */
export function CertificateView({certificate,onClose}:{certificate:Certificate;onClose:()=>void}){
  const c=certificate.content,vintages=[...new Set(c.credits.map(x=>x.vintage))].join(', '),retirement=c.kind==='RETIREMENT';
  const link=typeof window==='undefined'?'':verifyLink(window.location.origin,certificate.number,certificate.contentSha256);
  return <section className="certificate" aria-labelledby={`certificate-${certificate.number}`}>
    <p className="certificate-label">{c.label}</p>
    <h2 id={`certificate-${certificate.number}`}>{c.kind==='RETIREMENT'?'Certificate of retirement':'Certificate of purchase'}</h2>
    <dl className="certificate-facts">
      <dt>Certificate number</dt><dd>{certificate.number}</dd>
      <dt>{retirement?'Retired':'Issued'}</dt><dd>{DATE.format(new Date(c.issuedAt))}</dd>
      <dt>Buyer account</dt><dd>{c.buyer.account}</dd>
      {c.kind==='RETIREMENT'?<>
        <dt>Credits retired</dt><dd>{c.quantity} demo credit{c.quantity===1?'':'s'} · {c.quantity} tCO₂e · vintage {vintages}</dd>
        <dt>Reporting period</dt><dd>{c.reportingPeriod}</dd>
        <dt>Purpose</dt><dd>{c.purpose??'Not stated'}</dd>
        <dt>Bought under</dt><dd>{c.purchaseCertificates.length?c.purchaseCertificates.join(', '):'No purchase certificate was issued'}</dd>
      </>:<>
        <dt>Credits</dt><dd>{c.order.quantity} demo credit{c.order.quantity===1?'':'s'} · {c.order.quantity} tCO₂e · vintage {vintages}</dd>
        <dt>Price</dt><dd>{formatPaise(c.order.unitPricePaise)} each · total {formatPaise(c.order.payablePaise)} ({c.order.taxRule==='DEMO_ZERO'?'no tax in this demo':c.order.taxRule})</dd>
        <dt>Paid</dt><dd>{DATE.format(new Date(c.order.fulfilledAt))}</dd>
      </>}
    </dl>
    {retirement&&<p>These credits are retired: they are claimed by the buyer above for the reporting period, and can never be sold or retired again.</p>}
    <h3>Farmer groups supplying these credits</h3>
    <ul>{c.groups.map(g=><li key={g.group}>{g.group} · {g.credits} credit{g.credits===1?'':'s'}</li>)}</ul>
    {c.kind!=='RETIREMENT'&&<><h3>Blockchain proof</h3>
    <ul>{c.proofs.map(p=>{const l=proofLine(p);return <li key={p.group}>{l.href?<a href={l.href} target="_blank" rel="noreferrer">{l.text}</a>:l.text}</li>;})}</ul></>}
    <details open><summary>Credit identifiers ({c.credits.length})</summary><ul className="credit-list">{c.credits.map(x=><li key={x.id}><code>{x.id}</code></li>)}</ul></details>
    <h3>Check this certificate</h3>
    <p className="fingerprint">Content fingerprint (SHA-256): <code>{certificate.contentSha256}</code></p>
    {link&&<p>Verify it at <a href={link}>{link}</a></p>}
    <div className="button-row no-print"><button type="button" onClick={()=>window.print()}>Print or save as PDF</button><button type="button" className="secondary" onClick={onClose}>Close</button></div>
  </section>;
}
