/**
 * Payout and lot state machines (docs/23 §4, P10). Migration 0008 enforces the same tables in triggers; the schema tests check
 * the two agree pair by pair.
 */
export const PAYOUT_STATES=['PENDING','IN_SETTLEMENT','SENT','SETTLED','RETRY','INDETERMINATE','UNRESOLVED','NEEDS_REVIEW','RETURNED','CANCELLED'] as const;
export type PayoutState=typeof PAYOUT_STATES[number];
export const FINAL_PAYOUT_STATES:ReadonlySet<PayoutState>=new Set(['SETTLED','RETURNED','CANCELLED']);
const NEXT:Record<PayoutState,readonly PayoutState[]>={
  PENDING:['IN_SETTLEMENT'],
  RETRY:['IN_SETTLEMENT'],
  IN_SETTLEMENT:['SENT','SETTLED','RETRY','NEEDS_REVIEW','INDETERMINATE'],
  // Unknown outcome: resolved by key first. NOT_FOUND inside the window allows a resend (back to IN_SETTLEMENT).
  INDETERMINATE:['IN_SETTLEMENT','SENT','SETTLED','RETRY','NEEDS_REVIEW','UNRESOLVED'],
  // Still polled by key: a late FOUND must still settle.
  UNRESOLVED:['SENT','SETTLED','NEEDS_REVIEW','CANCELLED'],
  SENT:['SETTLED','RETURNED','NEEDS_REVIEW'],
  NEEDS_REVIEW:['CANCELLED','SENT','SETTLED'],
  SETTLED:[],RETURNED:[],CANCELLED:[],
};
export function canMovePayout(from:PayoutState,to:PayoutState,o:{nonPaymentConfirmed:boolean}):boolean{
  if(from===to)return !FINAL_PAYOUT_STATES.has(from);
  if(!NEXT[from].includes(to))return false;
  // Cancelling is only for money the rail confirmed it never paid, and money confirmed unpaid is never later sent or settled.
  if(to==='CANCELLED')return o.nonPaymentConfirmed;
  return !(o.nonPaymentConfirmed&&(to==='SENT'||to==='SETTLED'));
}
export type LotState='EARNED'|'IN_BATCH'|'PAID'|'RELEASED';
const LOT_NEXT:Record<LotState,readonly LotState[]>={EARNED:['IN_BATCH'],IN_BATCH:['PAID','RELEASED'],RELEASED:['IN_BATCH'],PAID:[]};
export function lotEventAllowed(previous:LotState|null,next:LotState):boolean{
  return previous===null?next==='EARNED':LOT_NEXT[previous].includes(next);
}
