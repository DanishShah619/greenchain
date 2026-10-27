/** Pure helpers for the earnings statement and the presenter's payout panel. Money stays integer paise in strings and BigInt. */
const DATE=new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'});
/** Rupees as typed (up to two decimals, positive) to exact paise, or null. */
export function rupeesToPaise(text:string):string|null{
  const m=/^([0-9]{1,13})(?:\.([0-9]{1,2}))?$/.exec(text.trim());
  if(!m)return null;
  const paise=BigInt(m[1])*100n+BigInt((m[2]??'').padEnd(2,'0')||'0');
  return paise>0n?String(paise):null;
}
export function paiseToRupeesInput(paise:string):string{
  const v=BigInt(paise);return `${v/100n}.${String(v%100n).padStart(2,'0')}`;
}
/** A percentage from 0 to 100 with at most two decimals, as basis points, or null. */
export function percentToBps(text:string):number|null{
  const m=/^([0-9]{1,3})(?:\.([0-9]{1,2}))?$/.exec(text.trim());
  if(!m)return null;
  const bps=Number(m[1])*100+Number((m[2]??'').padEnd(2,'0')||'0');
  return bps<=10000?bps:null;
}
export function bpsToPercent(bps:number):string{
  const whole=Math.floor(bps/100),rest=bps%100;
  return `${whole}${rest?`.${String(rest).padStart(2,'0').replace(/0$/,'')}`:''}%`;
}
export const LINE_STATE_LABELS:Record<string,string>={RELEASABLE:'Ready for the next payout',IN_PAYOUT:'In a payout',PAID:'Paid',NO_NET:'Nothing to pay (all commission)'};
/** Where one credit's earnings are now. A held lot shows the date it becomes payable (simulated time, India). */
export function lineStateLabel(state:string,releasableAt:string|null):string{
  if(state==='HELD')return releasableAt?`Held until ${DATE.format(new Date(releasableAt))} (first-payout holdback)`:'Held (first-payout holdback)';
  return LINE_STATE_LABELS[state]??state.replaceAll('_',' ').toLowerCase();
}
export const PAYOUT_STATE_LABELS:Record<string,string>={PENDING:'Waiting to send',IN_SETTLEMENT:'Sending',SENT:'Sent, awaiting settlement',SETTLED:'Paid',RETRY:'Retrying after a temporary failure',
  INDETERMINATE:'Checking the outcome with the bank',UNRESOLVED:'Outcome unknown, still checking',NEEDS_REVIEW:'Needs review',RETURNED:'Returned by the bank',CANCELLED:'Cancelled (not paid)'};
export const payoutStateLabel=(state:string)=>PAYOUT_STATE_LABELS[state]??state.replaceAll('_',' ').toLowerCase();
/** Payouts the worker is still moving, so the panel should refresh on its own. Review and final states wait for a person. */
export const inFlight=(payouts:{state:string}[])=>payouts.some(p=>['PENDING','IN_SETTLEMENT','SENT','RETRY','INDETERMINATE','UNRESOLVED'].includes(p.state));
export function clockLabel(offsetSeconds:number):string{
  if(offsetSeconds<=0)return 'Real time';
  const days=Math.floor(offsetSeconds/86400),hours=Math.floor((offsetSeconds%86400)/3600);
  const parts=[days?`${days} day${days===1?'':'s'}`:'',hours?`${hours} hour${hours===1?'':'s'}`:''].filter(Boolean);
  return `${parts.join(', ')||'Under an hour'} ahead`;
}
export const labelCode=(label:string)=>/^Group ([0-9A-F]{6})$/.exec(label)?.[1]??null;
/** What each sandbox account suffix makes the simulated bank do (docs/23 P9). */
export const SANDBOX_CHOICES:{suffix:string;label:string}[]=[
  {suffix:'00',label:'Pays normally'},{suffix:'02',label:'Times out, never pays'},{suffix:'03',label:'Times out, but pays'},
  {suffix:'04',label:'Fails twice, then pays'},{suffix:'05',label:'Rejects the account'},{suffix:'06',label:'Pays, then returns the money'},
  {suffix:'10',label:'Bank is down'},{suffix:'11',label:'Times out, pays late'},{suffix:'12',label:'Pays a different amount'}];
export const PAYOUT_MESSAGES:Record<string,string>={
  CLOCK_CONFLICT:'The clock moved since this screen loaded (another window?). Refresh, then try again.',
  CLOCK_LIMIT:'The demo clock can run at most one year ahead.',
  PAYOUT_MAY_BE_PAID:'This payout may still have been paid. It can be cancelled only once the bank confirms it was not, or after 24 simulated hours.',
  PAYOUT_NOT_CANCELLABLE:'Only payouts waiting for review or with an unresolved outcome can be cancelled.',
  PAYOUT_PROCESSED:'The bank reports this payout was already processed, so it was not cancelled. Its state has been updated.',
  RAIL_UNAVAILABLE:'The simulated bank could not confirm anything right now. Try again later.',
  VALIDATION_FAILED:'Check the values: the minimum payout must be positive and no larger than the limit.',
  BATCH_CONFLICT:'Another payout run started at the same moment. Refresh and try again.',
  SCENARIO_EMPTY:'This scenario has no farmer records yet.'};
export type BatchResult={replayed:boolean;runSeq:number;runDate:string;payouts:number;rolledOver:number;skippedReverify:number};
/** The presenter's summary of a payout run. A run that finds nothing says why, since the worker's daily run may have paid first. */
export function batchMessage(r:BatchResult):string{
  if(r.replayed)return 'That payout run had already been made.';
  const extras=[r.rolledOver?`${r.rolledOver} below the minimum carried over`:'',r.skippedReverify?`${r.skippedReverify} waiting for re-verification`:''].filter(Boolean);
  if(!r.payouts&&!extras.length)return `Payout run ${r.runSeq} for ${r.runDate}: Nothing new to pay. Earnings are still held, already in a payout, or were just paid by the worker's daily run.`;
  return `Payout run ${r.runSeq} for ${r.runDate}: ${r.payouts} payout${r.payouts===1?'':'s'} created${extras.length?`, ${extras.join(', ')}`:''}.`;
}
