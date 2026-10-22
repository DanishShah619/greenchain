import type {Database} from '../../../kernel/database.js';
/**
 * Market invariants (docs/22 §8). Used as the oracle by every market test and as a scheduled worker check.
 * Returns one entry per violation; an empty list means the market is consistent. The database guards prevent most of these
 * states outright; this check is what notices if a guard is ever removed or bypassed.
 */
export type Violation={code:string;ref:string};
export const INVARIANT_CODES=['SOLD_WITHOUT_FULFILMENT','RESERVED_WITHOUT_HOLD','HOLD_WITHOUT_CREDIT','HOLD_COUNT_MISMATCH','RELEASED_ORDER_HOLDS','RESERVATION_LAPSED','FULFILLED_TOTALS','FULFILLED_PAYMENT','REFUND_WITH_SALE','CAPTURE_NOT_ACCOUNTED','GROUP_STATE_WITHOUT_SALE'] as const;
export async function assertMarketInvariants(db:Database,options:{lapseGraceSeconds?:number}={}):Promise<Violation[]>{
  const grace=options.lapseGraceSeconds??120;
  const checks:[string,string,unknown[]][]=[
    // 1. SOLD <=> one ledger row, owned by a FULFILLED order that still holds it.
    ['SOLD_WITHOUT_FULFILMENT',`SELECT c.id AS ref FROM demo_credits c LEFT JOIN demo_orders o ON o.id=c.reserved_order_id WHERE c.state='SOLD' AND (o.state IS DISTINCT FROM 'FULFILLED'
       OR (SELECT count(*) FROM demo_ledger_entries l WHERE l.credit_id=c.id)<>1
       OR NOT EXISTS (SELECT 1 FROM demo_order_items i WHERE i.credit_id=c.id AND i.order_id=c.reserved_order_id AND i.active))`,[]],
    // 2. RESERVED <=> exactly one active hold, by its owner, which is in a holding state.
    ['RESERVED_WITHOUT_HOLD',`SELECT c.id AS ref FROM demo_credits c LEFT JOIN demo_orders o ON o.id=c.reserved_order_id WHERE c.state='RESERVED' AND (o.state IS NULL OR o.state NOT IN ('RESERVED','AWAITING_PAYMENT','REVALIDATING')
       OR (SELECT count(*) FROM demo_order_items i WHERE i.credit_id=c.id AND i.active)<>1
       OR NOT EXISTS (SELECT 1 FROM demo_order_items i WHERE i.credit_id=c.id AND i.order_id=c.reserved_order_id AND i.active))`,[]],
    ['HOLD_WITHOUT_CREDIT',`SELECT i.credit_id AS ref FROM demo_order_items i JOIN demo_credits c ON c.id=i.credit_id WHERE i.active AND (c.state NOT IN ('RESERVED','SOLD') OR c.reserved_order_id IS DISTINCT FROM i.order_id)`,[]],
    ['HOLD_COUNT_MISMATCH',`SELECT o.id::text AS ref FROM demo_orders o WHERE o.state IN ('RESERVED','AWAITING_PAYMENT','FULFILLED') AND (SELECT count(*) FROM demo_order_items i WHERE i.order_id=o.id AND i.active)<>o.allocated_quantity`,[]],
    ['RELEASED_ORDER_HOLDS',`SELECT o.id::text AS ref FROM demo_orders o WHERE o.state IN ('CREATED','CANCELLED','EXPIRED','REFUND_PENDING','REFUNDED') AND EXISTS (SELECT 1 FROM demo_order_items i WHERE i.order_id=o.id AND i.active)`,[]],
    // 3. No reservation outlives reserved_until by more than the sweep grace.
    ['RESERVATION_LAPSED',`SELECT o.id::text AS ref FROM demo_orders o WHERE o.state IN ('RESERVED','AWAITING_PAYMENT') AND o.reserved_until < now()-make_interval(secs=>$1)`,[grace]],
    // 4. A FULFILLED order reconciles to its ledger and to exactly one applied success event of the payable amount.
    ['FULFILLED_TOTALS',`SELECT o.id::text AS ref FROM demo_orders o WHERE o.state='FULFILLED' AND (
       (SELECT coalesce(sum(gross_paise),0) FROM demo_ledger_entries l WHERE l.order_id=o.id)<>o.principal_paise
       OR (SELECT count(*) FROM demo_ledger_entries l WHERE l.order_id=o.id)<>o.allocated_quantity
       OR o.principal_paise<>o.unit_price_paise*o.allocated_quantity)`,[]],
    ['FULFILLED_PAYMENT',`SELECT o.id::text AS ref FROM demo_orders o WHERE o.state='FULFILLED' AND (SELECT count(*) FROM demo_payment_events e JOIN demo_payment_attempts a ON a.id=e.attempt_id
       WHERE a.order_id=o.id AND e.outcome IN ('FULFILLED','REVALIDATED_FULFILLED') AND e.amount_paise=o.payable_paise)<>1`,[]],
    // 5. A refunded order sold nothing, and its refunds sum to the captured amount.
    ['REFUND_WITH_SALE',`SELECT o.id::text AS ref FROM demo_orders o WHERE o.state IN ('REFUND_PENDING','REFUNDED') AND EXISTS (SELECT 1 FROM demo_credits c WHERE c.reserved_order_id=o.id AND c.state='SOLD')`,[]],
    // Checked for every order, not only refunded ones: each applied success captured money, and that money is either the
    // fulfilled order's payable amount or owed back as a refund. A re-reported charge (IGNORED_SAME_ATTEMPT) captured nothing new.
    ['CAPTURE_NOT_ACCOUNTED',`SELECT o.id::text AS ref FROM demo_orders o WHERE
       (SELECT coalesce(sum(e.amount_paise),0) FROM demo_payment_events e JOIN demo_payment_attempts a ON a.id=e.attempt_id
         WHERE a.order_id=o.id AND e.type='payment.succeeded' AND e.outcome<>'IGNORED_SAME_ATTEMPT')
       <>(SELECT coalesce(sum(r.amount_paise),0) FROM demo_payment_refunds r WHERE r.order_id=o.id)+CASE WHEN o.state='FULFILLED' THEN o.payable_paise ELSE 0 END`,[]],
    // 6. A group's last allocation is only ever set by a fulfilment.
    ['GROUP_STATE_WITHOUT_SALE',`SELECT g.group_id::text AS ref FROM demo_group_state g WHERE NOT EXISTS (SELECT 1 FROM demo_ledger_entries l JOIN demo_orders o ON o.id=l.order_id
       WHERE l.payee_group_id=g.group_id AND o.state='FULFILLED' AND o.scenario_id=g.scenario_id)`,[]],
  ];
  const violations:Violation[]=[];
  for(const [code,sql,values] of checks)for(const row of (await db.query(sql,values)).rows)violations.push({code,ref:String(row.ref)});
  return violations;
}
