import {createHash} from 'node:crypto';
import {commissionPaise} from '../../market/domain/money.js';
/**
 * Double-entry posting rules for the demo ledger (docs/23 §6, docs/11 §3: E1, E2, E12, E13, E14). Pure: no I/O, BigInt paise
 * only. A posting is a total function of its inputs: zero-amount lines are dropped and a journal with fewer than two lines is
 * not posted at all, so an edge amount (0% or 100% commission, a reserve that rounds to 0) can never fail a sale.
 */
export type Account='buyer_funds_clearing'|'payee_payable'|'commission_revenue'|'reversal_reserve'|'payout_clearing'|'bank_cash';
export type JournalKind='EARNED'|'RESERVE_FUNDED'|'PAYOUT_BATCHED'|'PAYOUT_SETTLED'|'PAYOUT_REVERSED';
export type Line={account:Account;side:'DR'|'CR';amountPaise:bigint;payeeGroupId?:string};
export type JournalSpec={kind:JournalKind;key:string;lines:Line[];totalPaise:bigint;payloadHash:string};
/** A stable fingerprint of what a journal says, so a repeated idempotency key with different content is detected. */
export function payloadHash(kind:JournalKind,lines:readonly Line[]):string{
  const body=lines.map(l=>`${l.account}:${l.payeeGroupId??''}:${l.side}:${l.amountPaise}`).join(';');
  return createHash('sha256').update(`${kind}|${body}`).digest('hex');
}
export function journal(kind:JournalKind,key:string,lines:readonly Line[]):JournalSpec|null{
  for(const l of lines)if(l.amountPaise<0n)throw new Error('a journal line cannot be negative');
  const kept=lines.filter(l=>l.amountPaise>0n);
  if(kept.length<2)return null;
  for(const l of kept)if((l.account==='payee_payable')!==(l.payeeGroupId!==undefined))throw new Error('only payee_payable lines carry a payee');
  const dr=kept.filter(l=>l.side==='DR').reduce((n,l)=>n+l.amountPaise,0n),cr=kept.filter(l=>l.side==='CR').reduce((n,l)=>n+l.amountPaise,0n);
  if(dr!==cr)throw new Error(`journal ${key} does not balance (${dr} != ${cr})`);
  return {kind,key,lines:kept,totalPaise:dr,payloadHash:payloadHash(kind,kept)};
}
export type EarningInput={ledgerEntryId:string;payeeGroupId:string;grossPaise:bigint;commissionPaise:bigint;netPaise:bigint;reserveBps:number};
/** E1 at fulfilment (gross into payable and commission) and E2 (a share of commission into the reversal reserve). */
export function earningJournals(e:EarningInput):{earned:JournalSpec;funded:JournalSpec|null;reservePaise:bigint}{
  if(e.grossPaise<=0n||e.commissionPaise<0n||e.netPaise<0n||e.grossPaise!==e.commissionPaise+e.netPaise)throw new Error('gross must equal commission + net, all non-negative');
  const reservePaise=commissionPaise(e.commissionPaise,e.reserveBps);
  const earned=journal('EARNED',`EARN:${e.ledgerEntryId}`,[
    {account:'buyer_funds_clearing',side:'DR',amountPaise:e.grossPaise},
    {account:'payee_payable',side:'CR',amountPaise:e.netPaise,payeeGroupId:e.payeeGroupId},
    {account:'commission_revenue',side:'CR',amountPaise:e.commissionPaise}]);
  if(!earned)throw new Error('an earning always has a positive gross');
  const funded=journal('RESERVE_FUNDED',`FUND:${e.ledgerEntryId}`,[
    {account:'commission_revenue',side:'DR',amountPaise:reservePaise},
    {account:'reversal_reserve',side:'CR',amountPaise:reservePaise}]);
  return {earned,funded,reservePaise};
}
const positive=(amount:bigint)=>{if(amount<=0n)throw new Error('a payout amount must be positive');return amount;};
/** E12: the payout leaves the payee's payable balance into clearing until the rail settles it. */
export const payoutBatched=(payoutId:string,payeeGroupId:string,amount:bigint)=>journal('PAYOUT_BATCHED',`PB:${payoutId}`,[
  {account:'payee_payable',side:'DR',amountPaise:positive(amount),payeeGroupId},{account:'payout_clearing',side:'CR',amountPaise:amount}])!;
/** E13: the rail confirmed settlement. */
export const payoutSettled=(payoutId:string,amount:bigint)=>journal('PAYOUT_SETTLED',`PS:${payoutId}`,[
  {account:'payout_clearing',side:'DR',amountPaise:positive(amount)},{account:'bank_cash',side:'CR',amountPaise:amount}])!;
/** E14: confirmed non-payment (cancelled) or a returned transfer; the amount goes back to the payee's payable balance. */
export const payoutReversed=(payoutId:string,payeeGroupId:string,amount:bigint)=>journal('PAYOUT_REVERSED',`PC:${payoutId}`,[
  {account:'payout_clearing',side:'DR',amountPaise:positive(amount)},{account:'payee_payable',side:'CR',amountPaise:amount,payeeGroupId}])!;
