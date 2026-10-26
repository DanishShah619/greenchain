/**
 * The payout rail port (docs/23 P9, doc 12 §10). The payout id is the idempotency key: the rail must treat a repeated key as
 * the same transfer. A thrown error means the outcome is unknown (timeout, rail unreachable): the caller never retries blind,
 * it asks getByKey first.
 */
export type RailContext={scenarioId:string;key:string};
export type SendRequest=RailContext&{accountToken:string;amountPaise:bigint};
export type SendOutcome=
  |{kind:'ACCEPTED';railRef:string}
  |{kind:'SETTLED';railRef:string;amountPaise:bigint}
  |{kind:'REJECTED';code:string}            // definitive: nothing was or will be paid under this key
  |{kind:'TRANSIENT';code:string}           // definitive for this call: not accepted, may be retried
  |{kind:'CONFLICT'};                       // the key is known with a different token or amount
export type RailStatus='PROCESSING'|'SETTLED'|'REJECTED'|'RETURNED'|'VOIDED';
export type LookupOutcome={kind:'FOUND';status:RailStatus;amountPaise:bigint;railRef:string}|{kind:'NOT_FOUND'};
export type VoidOutcome='VOIDED'|'ALREADY_PROCESSED';
export interface PayoutRail{
  send(request:SendRequest):Promise<SendOutcome>;
  getByKey(context:RailContext):Promise<LookupOutcome>;
  voidKey(context:RailContext):Promise<VoidOutcome>;
  /** Sandbox only: advances simulated processing by one step. */
  tick?(scenarioId:string):Promise<void>;
}
/** An unknown outcome. `code` is safe to log. */
export class RailUnknownError extends Error{
  constructor(public code:'RAIL_TIMEOUT'|'RAIL_UNAVAILABLE'){super(code);}
}
