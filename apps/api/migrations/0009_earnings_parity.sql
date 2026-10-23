-- 0009_earnings_parity: every sale's earnings are written with it (docs/23 P3, §5 parity).
--   * a journal's payload hash must match its lines, so the hash is a faithful fingerprint of what was posted;
--   * a ledger row commits only if, in the same transaction, its order is FULFILLED with matching totals and it has its EARN
--     journal (exact lines), a lot with an EARNED event exactly when its net is positive, and the reserve journal its lot's
--     reserve share requires. This is checked per ledger row, so a row added later to a fulfilled order is caught as well.
-- Ledger rows written before this migration were backfilled by 0008 and are not re-checked.

-- The fingerprint of a journal as stored: the same string payloadHash() hashes in src/modules/payouts/domain/postings.ts.
CREATE FUNCTION journal_payload_hash(p_journal bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(e.kind || '|' || string_agg(l.account || ':' || coalesce(l.payee_group_id::text, '') || ':' || l.side || ':' || l.amount_paise::text, ';' ORDER BY l.line_no), 'UTF8')), 'hex')
  FROM demo_journal_entries e JOIN demo_journal_lines l ON l.journal_id = e.id WHERE e.id = p_journal GROUP BY e.kind;
$$;
-- The fingerprint E1 must have for a ledger row (zero lines omitted, as earningJournals() does).
CREATE FUNCTION earned_payload_hash(p_gross bigint, p_commission bigint, p_net bigint, p_payee uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to('EARNED|' || array_to_string(ARRAY[
    CASE WHEN p_gross > 0 THEN 'buyer_funds_clearing::DR:' || p_gross END,
    CASE WHEN p_net > 0 THEN 'payee_payable:' || p_payee || ':CR:' || p_net END,
    CASE WHEN p_commission > 0 THEN 'commission_revenue::CR:' || p_commission END], ';'), 'UTF8')), 'hex');
$$;

CREATE OR REPLACE FUNCTION check_journal(p_journal bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e demo_journal_entries%ROWTYPE; lines integer; dr numeric; cr numeric; bad record;
BEGIN
  SELECT * INTO e FROM demo_journal_entries WHERE id = p_journal;
  SELECT count(*), coalesce(sum(amount_paise) FILTER (WHERE side = 'DR'), 0), coalesce(sum(amount_paise) FILTER (WHERE side = 'CR'), 0)
    INTO lines, dr, cr FROM demo_journal_lines WHERE journal_id = p_journal;
  IF lines <> e.line_count THEN
    RAISE EXCEPTION 'journal % declares % lines but has %', p_journal, e.line_count, lines USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF dr <> cr OR dr <> e.total_paise THEN
    RAISE EXCEPTION 'journal % does not balance: DR % CR % declared %', p_journal, dr, cr, e.total_paise USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT l.account, l.side INTO bad FROM demo_journal_lines l WHERE l.journal_id = p_journal AND (l.account, l.side) NOT IN (
    SELECT a.account, a.side FROM (VALUES
      ('EARNED','buyer_funds_clearing','DR'),('EARNED','payee_payable','CR'),('EARNED','commission_revenue','CR'),
      ('RESERVE_FUNDED','commission_revenue','DR'),('RESERVE_FUNDED','reversal_reserve','CR'),
      ('PAYOUT_BATCHED','payee_payable','DR'),('PAYOUT_BATCHED','payout_clearing','CR'),
      ('PAYOUT_SETTLED','payout_clearing','DR'),('PAYOUT_SETTLED','bank_cash','CR'),
      ('PAYOUT_REVERSED','payout_clearing','DR'),('PAYOUT_REVERSED','payee_payable','CR')) AS a(kind, account, side) WHERE a.kind = e.kind) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % uses account % %, which a % journal cannot use', p_journal, bad.account, bad.side, e.kind USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF e.payload_hash <> journal_payload_hash(p_journal) THEN
    RAISE EXCEPTION 'journal % payload hash does not match its lines', p_journal USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END; $$;

CREATE FUNCTION check_ledger_earnings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o demo_orders%ROWTYPE; rows integer; gross numeric; lot_bps integer; fund_total bigint; fund_basis integer;
BEGIN
  SELECT * INTO o FROM demo_orders WHERE id = NEW.order_id;
  IF o.state IS DISTINCT FROM 'FULFILLED' THEN
    RAISE EXCEPTION 'ledger row % belongs to order % which is %, not FULFILLED', NEW.id, NEW.order_id, o.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT count(*), sum(gross_paise) INTO rows, gross FROM demo_ledger_entries WHERE order_id = NEW.order_id;
  IF rows <> o.allocated_quantity OR gross <> o.principal_paise THEN
    RAISE EXCEPTION 'ledger row % breaks order % totals (% rows, % paise for % credits and % paise)', NEW.id, NEW.order_id, rows, gross, o.allocated_quantity, o.principal_paise USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM demo_journal_entries WHERE idempotency_key = 'EARN:' || NEW.id
                 AND payload_hash = earned_payload_hash(NEW.gross_paise, NEW.commission_paise, NEW.net_paise, NEW.payee_group_id)) THEN
    RAISE EXCEPTION 'ledger row % has no matching EARN journal', NEW.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT reserve_bps INTO lot_bps FROM demo_earning_lots WHERE ledger_entry_id = NEW.id;
  IF (NEW.net_paise > 0) <> (lot_bps IS NOT NULL) THEN
    RAISE EXCEPTION 'ledger row % needs a lot exactly when its net is positive', NEW.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF lot_bps IS NOT NULL AND NOT EXISTS (SELECT 1 FROM demo_lot_events WHERE ledger_entry_id = NEW.id AND seq = 1) THEN
    RAISE EXCEPTION 'the lot of ledger row % has no EARNED event', NEW.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT total_paise, basis_bps INTO fund_total, fund_basis FROM demo_journal_entries WHERE idempotency_key = 'FUND:' || NEW.id;
  IF fund_total IS NOT NULL AND fund_total <> half_even_bps(NEW.commission_paise, fund_basis) THEN
    RAISE EXCEPTION 'the FUND journal of ledger row % is not the reserve share of its commission', NEW.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF lot_bps IS NOT NULL AND ((half_even_bps(NEW.commission_paise, lot_bps) > 0) <> (fund_total IS NOT NULL) OR (fund_total IS NOT NULL AND fund_basis <> lot_bps)) THEN
    RAISE EXCEPTION 'ledger row % must fund the reserve at its lot''s % bps', NEW.id, lot_bps USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER demo_ledger_entries_earnings AFTER INSERT ON demo_ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_earnings();
