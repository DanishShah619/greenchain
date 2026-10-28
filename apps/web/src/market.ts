/** Pure helpers for the buyer screens. Money arrives as integer paise in strings and is only ever handled as BigInt. */
export function formatPaise(paise:string|null|undefined):string{
  if(paise===null||paise===undefined||!/^-?[0-9]+$/.test(paise))return '—';
  const value=BigInt(paise),negative=value<0n,abs=negative?-value:value;
  const rupees=new Intl.NumberFormat('en-IN').format(abs/100n),cents=String(abs%100n).padStart(2,'0');
  return `${negative?'−':''}₹${rupees}.${cents}`;
}
/** Total for a quantity at a unit price, exactly (no floating point). */
export function quotePaise(unitPricePaise:string,quantity:number):string{
  if(!/^[0-9]+$/.test(unitPricePaise)||!Number.isInteger(quantity)||quantity<0)return '0';
  return String(BigInt(unitPricePaise)*BigInt(quantity));
}
/** A whole number of credits from 1 to 100, or null. The input text is kept as typed; it is never coerced to a default. */
export function parseQuantity(text:string):number|null{
  const trimmed=text.trim();
  if(!/^[0-9]{1,3}$/.test(trimmed))return null;
  const value=Number(trimmed);
  return value>=1&&value<=100?value:null;
}
export const ORDER_STATE_LABELS:Record<string,string>={
  CREATED:'Offer — nothing reserved',RESERVED:'Reserved for you',AWAITING_PAYMENT:'Waiting for payment',FULFILLED:'Purchased',
  CANCELLED:'Cancelled',EXPIRED:'Reservation expired',REVALIDATING:'Checking a late payment',REFUND_PENDING:'Refund in progress',REFUNDED:'Refunded'};
export const stateLabel=(state:string)=>ORDER_STATE_LABELS[state]??state.replaceAll('_',' ').toLowerCase();
export const SHORTFALL_REASONS:Record<string,string>={
  SUPPLY:'There are not enough available credits right now.',
  CAP:'No single farmer group may supply more than 15% of one order, and too few groups have credits for the full quantity.',
  QUOTA:'Each farmer group can have only half its credits reserved at once, and other reservations are holding the rest.'};
/** Plain-language messages for the buyer API's stable error codes. */
export const MARKET_MESSAGES:Record<string,string>={
  BUYER_LIMIT:'That is more than one buyer may hold at once (3 open orders, about 10% of available supply). Finish or cancel an order first, or ask for fewer credits.',
  PRICE_NOT_CONFIGURED:'No demo price is set yet, so nothing can be ordered. Ask the demo administrator.',
  SNAPSHOT_MISMATCH:'The order changed since you reviewed it. Refresh the order and check the total before paying.',
  ORDER_NOT_PAYABLE:'This order can no longer be paid: its reservation has ended or it is already settled. Refresh to see its status.',
  ORDER_NOT_CANCELLABLE:'A paid order cannot be cancelled here.',
  ORDER_NOT_PARTIAL:'This order is not waiting for a partial-fill decision.',
  NOTHING_TO_ACCEPT:'There is nothing to accept: no credits could be offered.',
  OFFER_EXPIRED:'This offer expired after 15 minutes. Place a new order.',
  KEY_REUSE:'This request was already sent with different details. Start a new order.',
  NO_PAYMENT_ATTEMPT:'The buyer has not started payment for this order yet.',
  NOTHING_TO_REPLAY:'There is no payment event to replay yet.',
  INVALID_QUANTITY:'Choose a whole number of credits from 1 to 100.'};
/** Whole minutes and seconds until an ISO time, or null once it has passed. */
export function remaining(untilIso:string|null,nowMs:number):string|null{
  if(!untilIso)return null;
  const ms=Date.parse(untilIso)-nowMs;if(!(ms>0))return null;
  const total=Math.floor(ms/1000);return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;
}
/** States in which credits are actually held for the buyer; other states keep reservedUntil only as history. */
export const isHolding=(state:string)=>['RESERVED','AWAITING_PAYMENT'].includes(state);
/** The hold countdown, shown only while credits are held (a paid order keeps its old reservedUntil). */
export const holdCountdown=(state:string,untilIso:string|null,nowMs:number)=>isHolding(state)?remaining(untilIso,nowMs):null;
/** Orders still moving on their own (the provider or the worker will change them), so the screen should refresh. */
export const isSettling=(state:string)=>['AWAITING_PAYMENT','REVALIDATING','REFUND_PENDING'].includes(state);
