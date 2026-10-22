import type {Metrics} from '../../../kernel/metrics.js';
/**
 * Market metrics (docs/22 §9). Label values come only from fixed sets (order states, outcomes, error codes, HTTP statuses),
 * never ids, so cardinality stays bounded.
 */
export const ORDER_STATES=['CREATED','RESERVED','AWAITING_PAYMENT','FULFILLED','CANCELLED','EXPIRED','REVALIDATING','REFUND_PENDING','REFUNDED'] as const;
export const PAYMENT_OUTCOMES=['FULFILLED','REVALIDATED_FULFILLED','REFUND_LATE_UNFILLABLE','REFUND_DUPLICATE_ATTEMPT','AMOUNT_MISMATCH','ATTEMPT_UPDATED','IGNORED_SAME_ATTEMPT','IGNORED_TERMINAL'] as const;
/** Read from the database by the worker, so they survive API restarts and agree across API instances. */
export function declareMarketWorkerMetrics(metrics:Metrics){
  metrics
    .declare('greenchain_orders','gauge','Orders by state.')
    .declare('greenchain_refunds_pending','gauge','Refunds owed to buyers and not yet settled.')
    .declare('greenchain_refund_oldest_pending_age_seconds','gauge','Age of the oldest unsettled refund (0 when none).')
    .declare('greenchain_payment_events','gauge','Applied payment events by outcome (all time).')
    .declare('greenchain_reservations_reaped_total','counter','Lapsed reservations expired by the worker sweep.')
    .declare('greenchain_shortfall_offers_cancelled_total','counter','Stale shortfall offers cancelled by the worker sweep.')
    .declare('greenchain_refunds_settled_total','counter','Refunds settled by the worker sweep.')
    .declare('greenchain_market_invariant_violations','gauge','Market invariant violations found by the last check, by code (docs/22 §8). Any non-zero value is a bug.')
    .declare('greenchain_market_invariant_check_age_seconds','gauge','Seconds since the market invariants were last checked (-1 if never).')
    .declare('greenchain_payment_events_parked','gauge','Payment events parked as dead letters, waiting for an operator retry. Any non-zero value needs attention.')
    .declare('greenchain_market_sweep_failures_total','counter','Market sweeps that failed (the rest of the worker cycle still ran).');
}
/** Counted in the API process, where webhooks and orders arrive. */
export function declareMarketApiMetrics(metrics:Metrics){
  metrics
    .declare('greenchain_webhook_requests_total','counter','Payment webhook requests by HTTP status.')
    .declare('greenchain_webhook_rejected_total','counter','Payment webhook requests refused before any write, by reason.')
    .declare('greenchain_payment_events_applied_total','counter','Payment events applied or replayed, by outcome.')
    .declare('greenchain_payment_event_failures_total','counter','Payment events whose apply failed and was rolled back (the provider retries), by code.')
    .declare('greenchain_orders_created_total','counter','POST /orders results: reserved, shortfall, replay, or an error code.')
    .declare('greenchain_scenario_lock_wait_seconds_total','counter','Total time market writers waited for the scenario lock.')
    .declare('greenchain_payment_events_parked_total','counter','Payment events parked after repeated apply failures.')
    .declare('greenchain_scenario_lock_acquisitions_total','counter','Scenario lock acquisitions (divide the wait total by this for the mean wait).');
}
