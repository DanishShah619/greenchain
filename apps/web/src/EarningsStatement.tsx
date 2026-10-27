'use client';
import {useEffect,useState} from 'react';
import {formatPaise} from './market';
import {lineStateLabel,payoutStateLabel} from './payouts';
type Request=(path:string,options?:RequestInit)=>Promise<any>;
type Line={creditId:string;earnedAt:string;grossPaise:string;commissionPaise:string;netPaise:string;reserveSharePaise:string;state:string;releasableAt:string|null};
type Statement={label:string;simulatedNow:string;lines:Line[];payouts:{state:string;amountPaise:string;createdAt:string}[];payableBalancePaise:string;
  totals:{grossPaise:string;commissionPaise:string;netPaise:string;reserveSharePaise:string;paidPaise:string}};
/**
 * The earnings statement of one case (docs/23 P12), for the agent who owns it: what each sold credit earned, where that money is
 * now, and the payouts made. Amounts are synthetic. Shows nothing when the case has no review record yet.
 */
export function EarningsStatement({caseId,request}:{caseId:string;request:Request}){
  const [statement,setStatement]=useState<Statement|null>(null),[message,setMessage]=useState(''),[hidden,setHidden]=useState(false);
  async function load(){
    try{setStatement(await request(`/cases/${caseId}/statement`));setMessage('');}
    catch(error){if((error as {code?:string}).code==='NOT_FOUND')setHidden(true);else setMessage(error instanceof Error?error.message:'Could not load the statement.');}
  }
  useEffect(()=>{load();},[caseId]);
  if(hidden)return null;
  const t=statement?.totals;
  return <section className="statement-panel" aria-labelledby={`statement-${caseId}`}>
    <div className="card-heading"><h3 id={`statement-${caseId}`}>Earnings statement{statement?` · ${statement.label}`:''}</h3><button type="button" className="text-button" onClick={load}>Refresh</button></div>
    {!statement&&!message&&<p role="status">Loading the statement…</p>}
    {statement&&t&&<>
      <div className="money-grid">
        <div><span>Credits sold for</span><strong>{formatPaise(t.grossPaise)}</strong></div>
        <div><span>Platform commission</span><strong>{formatPaise(t.commissionPaise)}</strong></div>
        <div><span>Earned by the farmer group</span><strong>{formatPaise(t.netPaise)}</strong></div>
        <div><span>Paid out</span><strong>{formatPaise(t.paidPaise)}</strong></div>
        <div><span>Not yet paid</span><strong>{formatPaise(statement.payableBalancePaise)}</strong></div>
      </div>
      <p className="help">Of the commission, {formatPaise(t.reserveSharePaise)} is set aside in a reserve that protects buyers if a credit is later reversed. It is never taken from the farmer group's earnings. A group's first payout waits 7 days after the sale.</p>
      {statement.lines.length?<div className="table-scroll"><table>
        <caption>Each sold credit</caption>
        <thead><tr><th scope="col">Credit</th><th scope="col">Sold for</th><th scope="col">Commission</th><th scope="col">Earned</th><th scope="col">Where it is</th></tr></thead>
        <tbody>{statement.lines.map(l=><tr key={l.creditId}><td title={l.creditId}>…{l.creditId.slice(-6)}</td><td>{formatPaise(l.grossPaise)}</td><td>{formatPaise(l.commissionPaise)}</td>
          <td>{formatPaise(l.netPaise)}</td><td>{lineStateLabel(l.state,l.releasableAt)}</td></tr>)}</tbody>
      </table></div>:<p>No credits from this case have been sold yet.</p>}
      {!!statement.payouts.length&&<><h4>Payouts</h4><ul className="payout-list">{statement.payouts.map((p,i)=><li key={`${p.createdAt}-${i}`}>
        <strong>{formatPaise(p.amountPaise)}</strong> · {payoutStateLabel(p.state)}</li>)}</ul></>}
    </>}
    <p role="status" aria-live="polite" className="status">{message}</p>
  </section>;
}
