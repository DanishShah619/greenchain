-- 0008_earnings_payouts: the tables and database guards of the payout slice (docs/23-demo-earnings-payouts.md §5), and the
-- backfill of sales made before it.
--   * per-scenario ledger configuration and a forward-only demo clock;
--   * synthetic payees (sandbox tokens only) and the payee lock row;
--   * a double-entry journal whose balance, size and accounts are checked at commit;
--   * earning lots and their append-only events; payout batches, payouts, items and attempts with their state machines;
--   * half_even_bps(), the SQL twin of commissionPaise(), so the backfill and invariants round exactly like the application.
-- The rule that every ledger row has its lot and EARN journal (parity) arrives with the code that writes them (0009).
-- The sandbox rail's own tables arrive with the rail (build step 4).

CREATE FUNCTION half_even_bps(amount bigint, bps integer) RETURNS bigint LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE n numeric; q numeric; r numeric;
BEGIN
  IF amount < 0 OR bps < 0 OR bps > 10000 THEN
    RAISE EXCEPTION 'half_even_bps needs a non-negative amount and 0..10000 bps' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  n := amount::numeric * bps; q := div(n, 10000); r := mod(n, 10000);
  -- Half-even: up above one half, down below it, to the even neighbour on an exact half (as commissionPaise does).
  IF 2 * r > 10000 OR (2 * r = 10000 AND mod(q, 2) = 1) THEN q := q + 1; END IF;
  RETURN q::bigint;
END; $$;

-- Journals and lots cite a ledger row together with its scenario, so nothing can cite another scenario's sale.
ALTER TABLE demo_ledger_entries ADD CONSTRAINT demo_ledger_entries_id_scenario UNIQUE (id, scenario_id);

-- Configuration and clock ---------------------------------------------------------------------------------------------
-- Version 0 is the built-in default (docs/23 P4) and is never a row; lots and batches record the version they used.
CREATE TABLE demo_ledger_config (
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),
  version integer NOT NULL CHECK (version >= 1),
  holdback_days integer NOT NULL CHECK (holdback_days BETWEEN 0 AND 365),
  reserve_bps integer NOT NULL CHECK (reserve_bps BETWEEN 0 AND 10000),
  min_payout_paise bigint NOT NULL CHECK (min_payout_paise > 0),
  payout_limit_paise bigint NOT NULL CHECK (payout_limit_paise >= min_payout_paise),
  backoff_base_seconds integer NOT NULL CHECK (backoff_base_seconds > 0),
  idempotency_window_seconds integer NOT NULL CHECK (idempotency_window_seconds > 0),
  effective_from timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, version)
);
CREATE TRIGGER demo_ledger_config_immutable BEFORE UPDATE OR DELETE ON demo_ledger_config FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

-- Simulated time = clock_timestamp() + offset (docs/23 P6). At most a year ahead, and never back.
CREATE TABLE demo_clock (
  scenario_id text PRIMARY KEY REFERENCES demo_namespaces(scenario_id),
  offset_seconds integer NOT NULL CHECK (offset_seconds BETWEEN 0 AND 31536000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_demo_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the demo clock cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.scenario_id IS DISTINCT FROM OLD.scenario_id THEN
    RAISE EXCEPTION 'the demo clock belongs to its scenario' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.offset_seconds < OLD.offset_seconds THEN
    RAISE EXCEPTION 'the demo clock only moves forward (% -> %)', OLD.offset_seconds, NEW.offset_seconds USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_clock_guard BEFORE UPDATE OR DELETE ON demo_clock FOR EACH ROW EXECUTE FUNCTION guard_demo_clock();

-- Payees ----------------------------------------------------------------------------------------------------------------
-- A payee is a farmer group (the case's capture id). No bank or identity data exists: the token is synthetic and its suffix
-- selects the sandbox rail's behaviour (docs/23 P2, P9).
CREATE TABLE demo_payees (
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),
  payee_group_id uuid NOT NULL,
  account_token text NOT NULL CHECK (account_token ~ '^SANDBOX-[0-9A-F]{8}-(00|02|03|04|05|06|10|11|12)$'),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, payee_group_id)
);
CREATE TABLE demo_payee_token_history (
  id bigserial PRIMARY KEY,
  scenario_id text NOT NULL,
  payee_group_id uuid NOT NULL,
  old_token text NOT NULL,
  new_token text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (scenario_id, payee_group_id) REFERENCES demo_payees(scenario_id, payee_group_id)
);
CREATE INDEX demo_payee_token_history_payee ON demo_payee_token_history(scenario_id, payee_group_id);
CREATE TRIGGER demo_payee_token_history_immutable BEFORE UPDATE OR DELETE ON demo_payee_token_history FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

CREATE FUNCTION guard_demo_payee() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payees cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.scenario_id IS DISTINCT FROM OLD.scenario_id OR NEW.payee_group_id IS DISTINCT FROM OLD.payee_group_id
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payee''s identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.account_token IS DISTINCT FROM OLD.account_token THEN
    IF left(NEW.account_token, -2) <> left(OLD.account_token, -2) THEN
      RAISE EXCEPTION 'only the sandbox suffix of a payee token can change' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    INSERT INTO demo_payee_token_history(scenario_id, payee_group_id, old_token, new_token) VALUES (OLD.scenario_id, OLD.payee_group_id, OLD.account_token, NEW.account_token);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_payees_guard BEFORE UPDATE OR DELETE ON demo_payees FOR EACH ROW EXECUTE FUNCTION guard_demo_payee();

-- The payee lock (docs/23 §6, lock order step 5): every writer of a payee's lots, journals or payouts holds this row.
CREATE TABLE demo_payee_state (
  scenario_id text NOT NULL,
  payee_group_id uuid NOT NULL,
  reverify_required boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, payee_group_id),
  FOREIGN KEY (scenario_id, payee_group_id) REFERENCES demo_payees(scenario_id, payee_group_id)
);
CREATE FUNCTION guard_demo_payee_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payee state cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.scenario_id IS DISTINCT FROM OLD.scenario_id OR NEW.payee_group_id IS DISTINCT FROM OLD.payee_group_id THEN
    RAISE EXCEPTION 'payee state belongs to its payee' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_payee_state_guard BEFORE UPDATE OR DELETE ON demo_payee_state FOR EACH ROW EXECUTE FUNCTION guard_demo_payee_state();

-- Batches and payouts ---------------------------------------------------------------------------------------------------
-- run_seq 0 is the worker's scheduled run (one per simulated IST day); presenter runs are 1, 2, ... and keyed by request id.
CREATE TABLE demo_payout_batches (
  id uuid PRIMARY KEY,
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),
  run_date date NOT NULL,
  run_seq integer NOT NULL CHECK (run_seq >= 0),
  request_id uuid,
  as_of_sim timestamptz NOT NULL,
  as_of_real timestamptz NOT NULL,
  min_payout_paise bigint NOT NULL CHECK (min_payout_paise > 0),
  payout_limit_paise bigint NOT NULL CHECK (payout_limit_paise >= min_payout_paise),
  config_version integer NOT NULL CHECK (config_version >= 0),
  status text NOT NULL CHECK (status IN ('RUNNING','PARTIAL','COMPLETED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (run_date = (as_of_sim AT TIME ZONE 'Asia/Kolkata')::date),
  CHECK ((run_seq = 0) = (request_id IS NULL)),
  CHECK ((status = 'COMPLETED') = (finished_at IS NOT NULL)),
  UNIQUE (scenario_id, run_date, run_seq),
  UNIQUE (scenario_id, request_id),
  UNIQUE (id, scenario_id)
);
CREATE INDEX demo_payout_batches_open ON demo_payout_batches(scenario_id) WHERE status <> 'COMPLETED';
CREATE FUNCTION guard_demo_payout_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RUNNING' THEN
      RAISE EXCEPTION 'a payout batch starts RUNNING, not %', NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout batches cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'finished_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'finished_at') THEN
    RAISE EXCEPTION 'a payout batch''s run and snapshot are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'payout batch % is final (COMPLETED)', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'RUNNING' AND NEW.status IN ('PARTIAL','COMPLETED')) OR (OLD.status = 'PARTIAL' AND NEW.status IN ('RUNNING','COMPLETED'))) THEN
    RAISE EXCEPTION 'illegal payout batch transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_payout_batches_guard BEFORE INSERT OR UPDATE OR DELETE ON demo_payout_batches FOR EACH ROW EXECUTE FUNCTION guard_demo_payout_batch();

-- The payout id is the rail's idempotency key. The token is a snapshot taken when the payout is built: a later suffix change
-- affects later payouts only (docs/23 P9, P10).
CREATE TABLE demo_payouts (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL,
  scenario_id text NOT NULL,
  payee_group_id uuid NOT NULL,
  account_token text NOT NULL,
  gross_paise bigint NOT NULL CHECK (gross_paise > 0),
  recovery_paise bigint NOT NULL DEFAULT 0 CHECK (recovery_paise = 0),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0 AND amount_paise = gross_paise - recovery_paise),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','IN_SETTLEMENT','SENT','SETTLED','RETRY','INDETERMINATE','UNRESOLVED','NEEDS_REVIEW','RETURNED','CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  next_attempt_at_sim timestamptz,
  first_request_sim timestamptz,
  lease_until_real timestamptz,
  non_payment_confirmed boolean NOT NULL DEFAULT false,
  flags text[] NOT NULL DEFAULT '{}',
  rail_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demo_payouts_unpaid_not_sent CHECK (NOT (non_payment_confirmed AND state IN ('SENT','SETTLED'))),
  FOREIGN KEY (batch_id, scenario_id) REFERENCES demo_payout_batches(id, scenario_id),
  FOREIGN KEY (scenario_id, payee_group_id) REFERENCES demo_payees(scenario_id, payee_group_id),
  UNIQUE (batch_id, payee_group_id),
  UNIQUE (id, scenario_id)
);
CREATE INDEX demo_payouts_payee ON demo_payouts(scenario_id, payee_group_id);
CREATE INDEX demo_payouts_due ON demo_payouts(scenario_id, state, next_attempt_at_sim) WHERE state NOT IN ('SETTLED','RETURNED','CANCELLED');

-- docs/23 P10, the same table as src/modules/payouts/domain/state.ts (the schema tests compare them pair by pair).
CREATE FUNCTION guard_demo_payout() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING' OR NEW.attempts <> 0 OR NEW.non_payment_confirmed OR NEW.first_request_sim IS NOT NULL OR NEW.rail_ref IS NOT NULL OR NEW.lease_until_real IS NOT NULL THEN
      RAISE EXCEPTION 'a payout starts PENDING with no attempt' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM demo_payees WHERE scenario_id = NEW.scenario_id AND payee_group_id = NEW.payee_group_id AND account_token = NEW.account_token) THEN
      RAISE EXCEPTION 'a payout''s token must be its payee''s current token' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payouts cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id
     OR NEW.payee_group_id IS DISTINCT FROM OLD.payee_group_id OR NEW.account_token IS DISTINCT FROM OLD.account_token
     OR NEW.gross_paise IS DISTINCT FROM OLD.gross_paise OR NEW.recovery_paise IS DISTINCT FROM OLD.recovery_paise
     OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payout''s identity, token snapshot and amounts are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('SETTLED','RETURNED','CANCELLED') THEN
    RAISE EXCEPTION 'payout % is final (%)', OLD.id, OLD.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.non_payment_confirmed AND NOT NEW.non_payment_confirmed THEN
    RAISE EXCEPTION 'non_payment_confirmed is never reset' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.first_request_sim IS NOT NULL AND NEW.first_request_sim IS DISTINCT FROM OLD.first_request_sim THEN
    RAISE EXCEPTION 'a payout''s first request time is set once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.rail_ref IS NOT NULL AND NEW.rail_ref IS DISTINCT FROM OLD.rail_ref THEN
    RAISE EXCEPTION 'a payout''s rail reference is set once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state IN ('PENDING','RETRY') AND NEW.state = 'IN_SETTLEMENT')
    OR (OLD.state = 'IN_SETTLEMENT' AND NEW.state IN ('SENT','SETTLED','RETRY','NEEDS_REVIEW','INDETERMINATE'))
    OR (OLD.state = 'INDETERMINATE' AND NEW.state IN ('IN_SETTLEMENT','SENT','SETTLED','RETRY','NEEDS_REVIEW','UNRESOLVED'))
    OR (OLD.state = 'UNRESOLVED' AND NEW.state IN ('SENT','SETTLED','NEEDS_REVIEW','CANCELLED'))
    OR (OLD.state = 'SENT' AND NEW.state IN ('SETTLED','RETURNED','NEEDS_REVIEW'))
    OR (OLD.state = 'NEEDS_REVIEW' AND NEW.state IN ('CANCELLED','SENT','SETTLED'))) THEN
    RAISE EXCEPTION 'illegal payout transition % -> %', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Cancelling is only for money confirmed unpaid; the CHECK above stops confirmed-unpaid money becoming SENT or SETTLED.
  IF NEW.state = 'CANCELLED' AND NOT NEW.non_payment_confirmed THEN
    RAISE EXCEPTION 'payout % may have been paid: only a confirmed-unpaid payout can be cancelled', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_payouts_guard BEFORE INSERT OR UPDATE OR DELETE ON demo_payouts FOR EACH ROW EXECUTE FUNCTION guard_demo_payout();

-- Journal ---------------------------------------------------------------------------------------------------------------
-- The idempotency key is derived from the kind and the reference, so a key always names what it posts (docs/23 §5).
CREATE TABLE demo_journal_entries (
  id bigserial PRIMARY KEY,
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),
  idempotency_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('EARNED','RESERVE_FUNDED','PAYOUT_BATCHED','PAYOUT_SETTLED','PAYOUT_REVERSED')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  line_count integer NOT NULL CHECK (line_count >= 2),
  total_paise bigint NOT NULL CHECK (total_paise > 0),
  ledger_entry_id bigint,
  payout_id uuid,
  basis_bps integer CHECK (basis_bps BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demo_journal_entries_ledger_ref CHECK ((kind IN ('EARNED','RESERVE_FUNDED')) = (ledger_entry_id IS NOT NULL)),
  CONSTRAINT demo_journal_entries_payout_ref CHECK ((kind IN ('PAYOUT_BATCHED','PAYOUT_SETTLED','PAYOUT_REVERSED')) = (payout_id IS NOT NULL)),
  CONSTRAINT demo_journal_entries_basis CHECK ((kind = 'RESERVE_FUNDED') = (basis_bps IS NOT NULL)),
  CONSTRAINT demo_journal_entries_key CHECK (idempotency_key = CASE kind
    WHEN 'EARNED' THEN 'EARN:' || ledger_entry_id WHEN 'RESERVE_FUNDED' THEN 'FUND:' || ledger_entry_id
    WHEN 'PAYOUT_BATCHED' THEN 'PB:' || payout_id WHEN 'PAYOUT_SETTLED' THEN 'PS:' || payout_id ELSE 'PC:' || payout_id END),
  FOREIGN KEY (ledger_entry_id, scenario_id) REFERENCES demo_ledger_entries(id, scenario_id),
  FOREIGN KEY (payout_id, scenario_id) REFERENCES demo_payouts(id, scenario_id),
  UNIQUE (id, scenario_id)
);
CREATE INDEX demo_journal_entries_ledger ON demo_journal_entries(ledger_entry_id) WHERE ledger_entry_id IS NOT NULL;
CREATE INDEX demo_journal_entries_payout ON demo_journal_entries(payout_id) WHERE payout_id IS NOT NULL;
CREATE TRIGGER demo_journal_entries_immutable BEFORE UPDATE OR DELETE ON demo_journal_entries FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

CREATE TABLE demo_journal_lines (
  journal_id bigint NOT NULL,
  scenario_id text NOT NULL,
  line_no smallint NOT NULL CHECK (line_no >= 1),
  account text NOT NULL CHECK (account IN ('buyer_funds_clearing','payee_payable','commission_revenue','reversal_reserve','payout_clearing','bank_cash')),
  payee_group_id uuid,
  side text NOT NULL CHECK (side IN ('DR','CR')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  PRIMARY KEY (journal_id, line_no),
  CONSTRAINT demo_journal_lines_payee CHECK ((account = 'payee_payable') = (payee_group_id IS NOT NULL)),
  FOREIGN KEY (journal_id, scenario_id) REFERENCES demo_journal_entries(id, scenario_id),
  FOREIGN KEY (scenario_id, payee_group_id) REFERENCES demo_payees(scenario_id, payee_group_id)
);
CREATE INDEX demo_journal_lines_balance ON demo_journal_lines(scenario_id, account, payee_group_id);
CREATE TRIGGER demo_journal_lines_immutable BEFORE UPDATE OR DELETE ON demo_journal_lines FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

-- Checked at commit from both tables, so an entry with no lines, a missing or extra line, and a line added in a later
-- transaction all fail. Each kind may only use its own accounts and sides (E1, E2, E12, E13, E14 of docs/11 §3).
CREATE FUNCTION check_journal(p_journal bigint) RETURNS void LANGUAGE plpgsql AS $$
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
END; $$;
CREATE FUNCTION check_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM check_journal(NEW.id); RETURN NULL; END; $$;
CREATE FUNCTION check_journal_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM check_journal(NEW.journal_id); RETURN NULL; END; $$;
CREATE CONSTRAINT TRIGGER demo_journal_entries_balanced AFTER INSERT ON demo_journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_entry();
CREATE CONSTRAINT TRIGGER demo_journal_lines_balanced AFTER INSERT ON demo_journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_line();

-- Lots ------------------------------------------------------------------------------------------------------------------
-- One per ledger row with a positive net (a 100% commission sale has nothing to pay). releasable_at_sim is decided once:
-- immediately, or after the holdback (docs/23 P5).
CREATE TABLE demo_earning_lots (
  ledger_entry_id bigint PRIMARY KEY,
  scenario_id text NOT NULL,
  payee_group_id uuid NOT NULL,
  net_paise bigint NOT NULL CHECK (net_paise > 0),
  earned_sim timestamptz NOT NULL,
  releasable_at_sim timestamptz NOT NULL,
  holdback_days integer NOT NULL CHECK (holdback_days BETWEEN 0 AND 365),
  reserve_bps integer NOT NULL CHECK (reserve_bps BETWEEN 0 AND 10000),
  config_version integer NOT NULL CHECK (config_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (releasable_at_sim = earned_sim OR releasable_at_sim = earned_sim + make_interval(days => holdback_days)),
  FOREIGN KEY (ledger_entry_id, scenario_id) REFERENCES demo_ledger_entries(id, scenario_id),
  FOREIGN KEY (scenario_id, payee_group_id) REFERENCES demo_payees(scenario_id, payee_group_id),
  UNIQUE (ledger_entry_id, scenario_id)
);
CREATE INDEX demo_earning_lots_payee ON demo_earning_lots(scenario_id, payee_group_id, earned_sim);
CREATE FUNCTION guard_demo_earning_lot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM demo_ledger_entries WHERE id = NEW.ledger_entry_id AND payee_group_id = NEW.payee_group_id AND net_paise = NEW.net_paise) THEN
    RAISE EXCEPTION 'lot % must copy its ledger row (payee and net)', NEW.ledger_entry_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_earning_lots_guard BEFORE INSERT ON demo_earning_lots FOR EACH ROW EXECUTE FUNCTION guard_demo_earning_lot();
CREATE TRIGGER demo_earning_lots_immutable BEFORE UPDATE OR DELETE ON demo_earning_lots FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

-- Payout items: which lots a payout pays. active stays true for PAID lots and becomes false only when the payout is
-- cancelled or returned, so the partial unique index allows a lot in one live payout at a time.
CREATE TABLE demo_payout_items (
  payout_id uuid NOT NULL,
  ledger_entry_id bigint NOT NULL,
  scenario_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (payout_id, ledger_entry_id),
  FOREIGN KEY (payout_id, scenario_id) REFERENCES demo_payouts(id, scenario_id),
  FOREIGN KEY (ledger_entry_id, scenario_id) REFERENCES demo_earning_lots(ledger_entry_id, scenario_id)
);
CREATE UNIQUE INDEX demo_payout_items_one_live ON demo_payout_items(ledger_entry_id) WHERE active;
CREATE FUNCTION guard_demo_payout_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout items cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT state, payee_group_id INTO p FROM demo_payouts WHERE id = NEW.payout_id;
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.active THEN
      RAISE EXCEPTION 'a payout item starts active' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF p.state IS DISTINCT FROM 'PENDING' THEN
      RAISE EXCEPTION 'items are added only while the payout is PENDING' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM demo_earning_lots WHERE ledger_entry_id = NEW.ledger_entry_id AND payee_group_id = p.payee_group_id) THEN
      RAISE EXCEPTION 'a payout item must be a lot of the payout''s payee' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.payout_id IS DISTINCT FROM OLD.payout_id OR NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id
     OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payout items are immutable except for release' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.active AND NOT OLD.active THEN
    RAISE EXCEPTION 'a released payout item is never reactivated; a later payout gets a new item' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.active AND NOT NEW.active AND p.state NOT IN ('CANCELLED','RETURNED') THEN
    RAISE EXCEPTION 'payout items are released only when the payout is CANCELLED or RETURNED, not %', p.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_payout_items_guard BEFORE INSERT OR UPDATE OR DELETE ON demo_payout_items FOR EACH ROW EXECUTE FUNCTION guard_demo_payout_item();

-- Lot events: EARNED -> IN_BATCH -> PAID | RELEASED -> IN_BATCH ... (docs/23 §4). Each event must agree with the payout it
-- names, so the payout row is updated before the events that follow from it.
CREATE TABLE demo_lot_events (
  ledger_entry_id bigint NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  scenario_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('EARNED','IN_BATCH','PAID','RELEASED')),
  payout_id uuid,
  at_sim timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ledger_entry_id, seq),
  CHECK ((state = 'EARNED') = (payout_id IS NULL)),
  FOREIGN KEY (ledger_entry_id, scenario_id) REFERENCES demo_earning_lots(ledger_entry_id, scenario_id),
  FOREIGN KEY (payout_id, scenario_id) REFERENCES demo_payouts(id, scenario_id)
);
CREATE INDEX demo_lot_events_payout ON demo_lot_events(payout_id) WHERE payout_id IS NOT NULL;
CREATE FUNCTION guard_demo_lot_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev demo_lot_events%ROWTYPE; payout_state text;
BEGIN
  SELECT * INTO prev FROM demo_lot_events WHERE ledger_entry_id = NEW.ledger_entry_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> coalesce(prev.seq, 0) + 1 THEN
    RAISE EXCEPTION 'lot % event sequence: expected %, got %', NEW.ledger_entry_id, coalesce(prev.seq, 0) + 1, NEW.seq USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT ((prev.state IS NULL AND NEW.state = 'EARNED')
       OR (prev.state IN ('EARNED','RELEASED') AND NEW.state = 'IN_BATCH')
       OR (prev.state = 'IN_BATCH' AND NEW.state IN ('PAID','RELEASED'))) THEN
    RAISE EXCEPTION 'illegal lot transition % -> %', coalesce(prev.state, 'none'), NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'EARNED' THEN
    RETURN NEW;
  END IF;
  SELECT state INTO payout_state FROM demo_payouts WHERE id = NEW.payout_id;
  IF NEW.state = 'IN_BATCH' THEN
    IF NOT EXISTS (SELECT 1 FROM demo_payout_items WHERE payout_id = NEW.payout_id AND ledger_entry_id = NEW.ledger_entry_id AND active) THEN
      RAISE EXCEPTION 'lot % can only be batched with an active payout item', NEW.ledger_entry_id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.payout_id IS DISTINCT FROM prev.payout_id THEN
    RAISE EXCEPTION 'lot % is paid or released by the payout that batched it', NEW.ledger_entry_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'PAID' AND payout_state IS DISTINCT FROM 'SETTLED' THEN
    RAISE EXCEPTION 'lot % is paid only once payout % is SETTLED (it is %)', NEW.ledger_entry_id, NEW.payout_id, payout_state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'RELEASED' AND payout_state NOT IN ('CANCELLED','RETURNED') THEN
    RAISE EXCEPTION 'lot % is released only by a CANCELLED or RETURNED payout (it is %)', NEW.ledger_entry_id, payout_state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_lot_events_guard BEFORE INSERT ON demo_lot_events FOR EACH ROW EXECUTE FUNCTION guard_demo_lot_event();
CREATE TRIGGER demo_lot_events_immutable BEFORE UPDATE OR DELETE ON demo_lot_events FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

-- Attempts: append-only, numbered from 1, at most one open (no outcome yet) per payout; the outcome is written once.
CREATE TABLE demo_payout_attempts (
  payout_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 6),
  scenario_id text NOT NULL,
  requested_at_real timestamptz NOT NULL DEFAULT now(),
  requested_at_sim timestamptz NOT NULL,
  outcome_at timestamptz,
  class text CHECK (class IN ('ACCEPTED','SETTLED','TRANSIENT','REJECTED','RESOLVED_ABSENT','RESOLVED_FOUND')),
  rail_ref text,
  PRIMARY KEY (payout_id, attempt_no),
  CHECK ((outcome_at IS NULL) = (class IS NULL)),
  FOREIGN KEY (payout_id, scenario_id) REFERENCES demo_payouts(id, scenario_id)
);
CREATE UNIQUE INDEX demo_payout_attempts_one_open ON demo_payout_attempts(payout_id) WHERE outcome_at IS NULL;
CREATE FUNCTION guard_demo_payout_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout attempts cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT max(attempt_no) INTO last FROM demo_payout_attempts WHERE payout_id = NEW.payout_id;
    IF NEW.attempt_no <> coalesce(last, 0) + 1 THEN
      RAISE EXCEPTION 'payout % attempt sequence: expected %, got %', NEW.payout_id, coalesce(last, 0) + 1, NEW.attempt_no USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.outcome_at IS NOT NULL OR NEW.rail_ref IS NOT NULL THEN
      RAISE EXCEPTION 'an attempt starts open, with no outcome' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.payout_id IS DISTINCT FROM OLD.payout_id OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id
     OR NEW.requested_at_real IS DISTINCT FROM OLD.requested_at_real OR NEW.requested_at_sim IS DISTINCT FROM OLD.requested_at_sim THEN
    RAISE EXCEPTION 'an attempt''s identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (OLD.outcome_at IS NOT NULL AND NEW.outcome_at IS DISTINCT FROM OLD.outcome_at) OR (OLD.class IS NOT NULL AND NEW.class IS DISTINCT FROM OLD.class)
     OR (OLD.rail_ref IS NOT NULL AND NEW.rail_ref IS DISTINCT FROM OLD.rail_ref) THEN
    RAISE EXCEPTION 'an attempt''s outcome is written once' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_payout_attempts_guard BEFORE INSERT OR UPDATE OR DELETE ON demo_payout_attempts FOR EACH ROW EXECUTE FUNCTION guard_demo_payout_attempt();

-- Backfill --------------------------------------------------------------------------------------------------------------
-- Sales made before this migration get what postEarnings would have written, under the built-in defaults (version 0,
-- reserve 2000 bps) and with no holdback (they were already sold). Line text and payload hash follow payloadHash() in
-- src/modules/payouts/domain/postings.ts exactly; a test compares them.
INSERT INTO demo_payees(scenario_id, payee_group_id, account_token, verified_at)
  SELECT DISTINCT scenario_id, payee_group_id, 'SANDBOX-' || upper(substr(replace(payee_group_id::text, '-', ''), 1, 8)) || '-00', now()
  FROM demo_ledger_entries ON CONFLICT DO NOTHING;
INSERT INTO demo_payee_state(scenario_id, payee_group_id) SELECT scenario_id, payee_group_id FROM demo_payees ON CONFLICT DO NOTHING;

INSERT INTO demo_earning_lots(ledger_entry_id, scenario_id, payee_group_id, net_paise, earned_sim, releasable_at_sim, holdback_days, reserve_bps, config_version)
  SELECT id, scenario_id, payee_group_id, net_paise, created_at, created_at, 0, 2000, 0 FROM demo_ledger_entries WHERE net_paise > 0
  ON CONFLICT DO NOTHING;
INSERT INTO demo_lot_events(ledger_entry_id, seq, scenario_id, state, at_sim)
  SELECT l.ledger_entry_id, 1, l.scenario_id, 'EARNED', l.earned_sim FROM demo_earning_lots l
  WHERE NOT EXISTS (SELECT 1 FROM demo_lot_events e WHERE e.ledger_entry_id = l.ledger_entry_id);

CREATE TEMP TABLE backfill_journal_lines ON COMMIT DROP AS
  SELECT e.id AS ledger_id, e.scenario_id, x.kind, x.no, x.account, x.payee, x.side, x.amount, x.basis
  FROM demo_ledger_entries e
  CROSS JOIN LATERAL (VALUES
    ('EARNED', 1, 'buyer_funds_clearing', NULL::uuid, 'DR', e.gross_paise, NULL::integer),
    ('EARNED', 2, 'payee_payable', e.payee_group_id, 'CR', e.net_paise, NULL),
    ('EARNED', 3, 'commission_revenue', NULL, 'CR', e.commission_paise, NULL),
    ('RESERVE_FUNDED', 1, 'commission_revenue', NULL, 'DR', half_even_bps(e.commission_paise, 2000), 2000),
    ('RESERVE_FUNDED', 2, 'reversal_reserve', NULL, 'CR', half_even_bps(e.commission_paise, 2000), 2000)) AS x(kind, no, account, payee, side, amount, basis)
  WHERE x.amount > 0 AND e.gross_paise > 0;

INSERT INTO demo_journal_entries(scenario_id, idempotency_key, kind, payload_hash, line_count, total_paise, ledger_entry_id, basis_bps)
  SELECT scenario_id, CASE kind WHEN 'EARNED' THEN 'EARN:' ELSE 'FUND:' END || ledger_id, kind,
    encode(sha256(convert_to(kind || '|' || string_agg(account || ':' || coalesce(payee::text, '') || ':' || side || ':' || amount::text, ';' ORDER BY no), 'UTF8')), 'hex'),
    count(*), sum(amount) FILTER (WHERE side = 'DR'), ledger_id, max(basis)
  FROM backfill_journal_lines GROUP BY scenario_id, kind, ledger_id
  ON CONFLICT (idempotency_key) DO NOTHING;
INSERT INTO demo_journal_lines(journal_id, scenario_id, line_no, account, payee_group_id, side, amount_paise)
  SELECT j.id, b.scenario_id, row_number() OVER (PARTITION BY j.id ORDER BY b.no), b.account, b.payee, b.side, b.amount
  FROM backfill_journal_lines b
  JOIN demo_journal_entries j ON j.idempotency_key = CASE b.kind WHEN 'EARNED' THEN 'EARN:' ELSE 'FUND:' END || b.ledger_id
  WHERE NOT EXISTS (SELECT 1 FROM demo_journal_lines x WHERE x.journal_id = j.id);
