import type {Database} from '../../../kernel/database.js';
import {groupLabel} from '../../market/application/orders.js';
/**
 * The ledger invariants of docs/23 §8, for one scenario, read in a single REPEATABLE READ snapshot so a batch or settlement
 * committing mid-check cannot produce a false positive. The database guards prevent these states; this is what notices if a
 * guard is ever removed or bypassed. Refs are journal ids, ledger ids, payout ids or payee labels, never a payee (case) id.
 */
export type PayoutViolation={code:string;ref:string};
export const PAYOUT_INVARIANT_CODES=['JOURNAL_UNBALANCED','PAYABLE_MISMATCH','LEDGER_PARITY','PAYOUT_ITEMS_MISMATCH','LOT_PAYOUT_STATE','CLEARING_MISMATCH','RESERVE_MISMATCH','CONSERVATION','BUYER_CLEARING'] as const;
const LATEST=`JOIN LATERAL (SELECT state,payout_id FROM demo_lot_events WHERE ledger_entry_id=l.ledger_entry_id ORDER BY seq DESC LIMIT 1) ev ON true`;
const BALANCE=(account:string,payee='')=>`(SELECT coalesce(sum(CASE side WHEN 'CR' THEN amount_paise ELSE -amount_paise END),0) FROM demo_journal_lines
  WHERE scenario_id=$1 AND account='${account}'${payee?` AND payee_group_id=${payee}`:''})`;
const LIVE=`state NOT IN ('SETTLED','RETURNED','CANCELLED')`;
const CHECKS:[typeof PAYOUT_INVARIANT_CODES[number],string,'payee'|'plain'][]=[
  // 1. Every journal balances and matches its declared size and payload hash.
  ['JOURNAL_UNBALANCED',`SELECT e.id::text AS ref FROM demo_journal_entries e
    CROSS JOIN LATERAL (SELECT count(*) AS n,coalesce(sum(amount_paise) FILTER (WHERE side='DR'),0) AS dr,coalesce(sum(amount_paise) FILTER (WHERE side='CR'),0) AS cr
      FROM demo_journal_lines WHERE journal_id=e.id) x
    WHERE e.scenario_id=$1 AND (x.n<>e.line_count OR x.dr<>x.cr OR x.dr<>e.total_paise OR e.payload_hash IS DISTINCT FROM journal_payload_hash(e.id))`,'plain'],
  // 2. payee_payable[P] = net of P's lots that are EARNED or RELEASED (and so never negative).
  ['PAYABLE_MISMATCH',`SELECT p.payee_group_id::text AS ref FROM demo_payees p WHERE p.scenario_id=$1 AND ${BALANCE('payee_payable','p.payee_group_id')}
    <>(SELECT coalesce(sum(l.net_paise),0) FROM demo_earning_lots l ${LATEST} WHERE l.scenario_id=$1 AND l.payee_group_id=p.payee_group_id AND ev.state IN ('EARNED','RELEASED'))`,'payee'],
  // 3. Each ledger row has one EARN journal with exactly the expected lines, and a matching lot exactly when its net is positive.
  ['LEDGER_PARITY',`SELECT e.id::text AS ref FROM demo_ledger_entries e WHERE e.scenario_id=$1 AND (
    (SELECT count(*) FROM demo_journal_entries j WHERE j.idempotency_key='EARN:'||e.id AND j.payload_hash=earned_payload_hash(e.gross_paise,e.commission_paise,e.net_paise,e.payee_group_id))<>1
    OR (e.net_paise>0)<>EXISTS (SELECT 1 FROM demo_earning_lots l WHERE l.ledger_entry_id=e.id AND l.net_paise=e.net_paise AND l.payee_group_id=e.payee_group_id))`,'plain'],
  // 4. A payout that was not reversed is worth exactly its active items; lot states agree with their payout.
  ['PAYOUT_ITEMS_MISMATCH',`SELECT p.id::text AS ref FROM demo_payouts p WHERE p.scenario_id=$1 AND p.state NOT IN ('RETURNED','CANCELLED') AND p.gross_paise<>
    (SELECT coalesce(sum(l.net_paise),0) FROM demo_payout_items i JOIN demo_earning_lots l ON l.ledger_entry_id=i.ledger_entry_id WHERE i.payout_id=p.id AND i.active)`,'plain'],
  ['LOT_PAYOUT_STATE',`SELECT l.ledger_entry_id::text AS ref FROM demo_earning_lots l ${LATEST} LEFT JOIN demo_payouts p ON p.id=ev.payout_id WHERE l.scenario_id=$1 AND (
      (ev.state='IN_BATCH' AND p.state IN ('SETTLED','RETURNED','CANCELLED')) OR (ev.state='PAID' AND p.state IS DISTINCT FROM 'SETTLED')
      OR (ev.state='RELEASED' AND p.state NOT IN ('RETURNED','CANCELLED')))
    UNION ALL
    SELECT i.ledger_entry_id::text FROM demo_payouts p JOIN demo_payout_items i ON i.payout_id=p.id AND i.active JOIN demo_earning_lots l ON l.ledger_entry_id=i.ledger_entry_id ${LATEST}
    WHERE p.scenario_id=$1 AND p.state='SETTLED' AND ev.state<>'PAID'`,'plain'],
  // 5. payout_clearing (E12 - E13 - E14) holds exactly the payouts still in flight.
  ['CLEARING_MISMATCH',`SELECT 'payout_clearing' AS ref WHERE ${BALANCE('payout_clearing')}<>(SELECT coalesce(sum(amount_paise),0) FROM demo_payouts WHERE scenario_id=$1 AND ${LIVE})`,'plain'],
  // 6. Each E2 is the half-even reserve share of its commission at its basis, and the reserve holds exactly the E2s.
  ['RESERVE_MISMATCH',`SELECT j.id::text AS ref FROM demo_journal_entries j JOIN demo_ledger_entries e ON e.id=j.ledger_entry_id
      WHERE j.scenario_id=$1 AND j.kind='RESERVE_FUNDED' AND j.total_paise<>half_even_bps(e.commission_paise,j.basis_bps)
    UNION ALL
    SELECT 'reversal_reserve' WHERE ${BALANCE('reversal_reserve')}<>(SELECT coalesce(sum(total_paise),0) FROM demo_journal_entries WHERE scenario_id=$1 AND kind='RESERVE_FUNDED')`,'plain'],
  // 7. Conservation per payee: every net is payable, or in a payout that was not reversed.
  ['CONSERVATION',`SELECT p.payee_group_id::text AS ref FROM demo_payees p WHERE p.scenario_id=$1 AND
    (SELECT coalesce(sum(net_paise),0) FROM demo_ledger_entries WHERE scenario_id=$1 AND payee_group_id=p.payee_group_id)
    <>${BALANCE('payee_payable','p.payee_group_id')}+(SELECT coalesce(sum(amount_paise),0) FROM demo_payouts WHERE scenario_id=$1 AND payee_group_id=p.payee_group_id AND state NOT IN ('RETURNED','CANCELLED'))`,'payee'],
  // 8. Buyer funds clearing is debited by exactly the gross of every sale.
  ['BUYER_CLEARING',`SELECT 'buyer_funds_clearing' AS ref WHERE -${BALANCE('buyer_funds_clearing')}<>(SELECT coalesce(sum(gross_paise),0) FROM demo_ledger_entries WHERE scenario_id=$1)`,'plain'],
];
export async function assertPayoutInvariants(db:Database,scenarioId:string):Promise<PayoutViolation[]>{
  return db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const violations:PayoutViolation[]=[];
    for(const [code,sql,kind] of CHECKS)for(const row of (await tx.query(sql,[scenarioId])).rows)
      violations.push({code,ref:kind==='payee'?groupLabel(row.ref as string):String(row.ref)});
    return violations;
  });
}
