-- 0005_buyer_orders: the buyer slice (docs/22-demo-buyer-purchase.md §5).
--   * a 'buyer' role; an effective-dated price list;
--   * orders, order items (who holds which credit), allocation log, payment attempts/events/refunds, a per-credit ledger;
--   * demo_credits learns who holds it (reserved_order_id) and since when it was available (available_since);
--   * the credit guard is extended so a credit cannot be reserved or sold without a matching order.
-- Every rule below is a database guarantee, so it holds even if application code is wrong. Application code is the second line.

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('agent','verifier','buyer'));

CREATE TABLE demo_price_list (
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),
  effective_from timestamptz NOT NULL,
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, effective_from)
);
CREATE TRIGGER demo_price_list_immutable BEFORE UPDATE OR DELETE ON demo_price_list FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

CREATE TABLE demo_orders (
  id uuid PRIMARY KEY,
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),
  buyer_id text NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  allocated_quantity integer NOT NULL DEFAULT 0 CHECK (allocated_quantity >= 0 AND allocated_quantity <= quantity),
  state text NOT NULL CHECK (state IN ('CREATED','RESERVED','AWAITING_PAYMENT','FULFILLED','CANCELLED','EXPIRED','REVALIDATING','REFUND_PENDING','REFUNDED')),
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise > 0),
  price_effective_from timestamptz NOT NULL,
  commission_bps integer NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
  principal_paise bigint NOT NULL DEFAULT 0 CHECK (principal_paise = unit_price_paise * allocated_quantity),
  tax_paise bigint NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  tax_rule text NOT NULL DEFAULT 'DEMO_ZERO',
  payable_paise bigint NOT NULL DEFAULT 0 CHECK (payable_paise = principal_paise + tax_paise),
  shortfall_reason text CHECK (shortfall_reason IN ('SUPPLY','CAP','QUOTA')),
  reserved_until timestamptz,
  allocated_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, buyer_id, request_id),
  UNIQUE (id, scenario_id)
);
CREATE INDEX demo_orders_buyer ON demo_orders(scenario_id, buyer_id, created_at DESC);
CREATE INDEX demo_orders_reaper ON demo_orders(scenario_id, reserved_until) WHERE state IN ('RESERVED','AWAITING_PAYMENT');

CREATE TABLE demo_order_items (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL,
  scenario_id text NOT NULL,
  credit_id text NOT NULL REFERENCES demo_credits(id),
  group_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation >= 1),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, scenario_id) REFERENCES demo_orders(id, scenario_id)
);
-- active means "held or sold": it stays true after fulfilment. These two indexes are what make a double sale impossible.
CREATE UNIQUE INDEX demo_items_one_active_credit ON demo_order_items(credit_id) WHERE active;
CREATE UNIQUE INDEX demo_items_order_credit_active ON demo_order_items(order_id, credit_id) WHERE active;
CREATE INDEX demo_items_order ON demo_order_items(order_id, generation);

CREATE TABLE demo_allocation_log (
  order_id uuid PRIMARY KEY,
  scenario_id text NOT NULL,
  as_of timestamptz NOT NULL,
  cap_basis_q integer NOT NULL CHECK (cap_basis_q >= 1),
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, scenario_id) REFERENCES demo_orders(id, scenario_id)
);
CREATE TRIGGER demo_allocation_log_immutable BEFORE UPDATE OR DELETE ON demo_allocation_log FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

CREATE TABLE demo_payment_attempts (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  scenario_id text NOT NULL,
  provider text NOT NULL,
  provider_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('CREATED','PENDING','SUCCEEDED','FAILED','CANCELLED')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  mismatch boolean NOT NULL DEFAULT false,
  snapshot_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref),
  UNIQUE (id, scenario_id),
  FOREIGN KEY (order_id, scenario_id) REFERENCES demo_orders(id, scenario_id)
);
CREATE INDEX demo_attempts_order ON demo_payment_attempts(order_id);

-- Written last, in the same transaction that applies the event, with its final outcome (docs/22 §6.1). Never updated.
CREATE TABLE demo_payment_events (
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  attempt_id uuid NOT NULL REFERENCES demo_payment_attempts(id),
  scenario_id text NOT NULL,
  type text NOT NULL,
  payload_hash text NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  outcome text NOT NULL CHECK (outcome IN ('FULFILLED','REVALIDATED_FULFILLED','REFUND_LATE_UNFILLABLE','REFUND_DUPLICATE_ATTEMPT','AMOUNT_MISMATCH','ATTEMPT_UPDATED','IGNORED_SAME_ATTEMPT','IGNORED_TERMINAL')),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_event_id)
);
CREATE TRIGGER demo_payment_events_immutable BEFORE UPDATE OR DELETE ON demo_payment_events FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

CREATE TABLE demo_payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  scenario_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('LATE_UNFILLABLE','DUPLICATE_ATTEMPT','AMOUNT_MISMATCH')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','REFUNDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (attempt_id, kind),
  FOREIGN KEY (order_id, scenario_id) REFERENCES demo_orders(id, scenario_id),
  FOREIGN KEY (attempt_id, scenario_id) REFERENCES demo_payment_attempts(id, scenario_id)
);

CREATE TABLE demo_ledger_entries (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL,
  scenario_id text NOT NULL,
  credit_id text NOT NULL UNIQUE REFERENCES demo_credits(id),
  payee_group_id uuid NOT NULL,
  gross_paise bigint NOT NULL CHECK (gross_paise >= 0),
  commission_paise bigint NOT NULL CHECK (commission_paise >= 0),
  net_paise bigint NOT NULL CHECK (net_paise >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gross_paise = commission_paise + net_paise),
  FOREIGN KEY (order_id, scenario_id) REFERENCES demo_orders(id, scenario_id)
);
CREATE INDEX demo_ledger_order ON demo_ledger_entries(order_id);
CREATE TRIGGER demo_ledger_immutable BEFORE UPDATE OR DELETE ON demo_ledger_entries FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

-- Set only when an order is FULFILLED, so reserving and abandoning cannot reset a farmer group's waiting time.
CREATE TABLE demo_group_state (
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),
  group_id uuid NOT NULL,
  last_allocated_at timestamptz NOT NULL,
  PRIMARY KEY (scenario_id, group_id)
);

-- Credits: who holds them and since when they were available. Backfill happens before the guard is replaced.
ALTER TABLE demo_credits ADD COLUMN available_since timestamptz NOT NULL DEFAULT now();
UPDATE demo_credits c SET available_since = b.created_at FROM demo_issuance_batches b WHERE b.id = c.batch_id;
ALTER TABLE demo_credits ADD COLUMN reserved_order_id uuid REFERENCES demo_orders(id);
ALTER TABLE demo_credits ADD CONSTRAINT demo_credits_owner CHECK (
  CASE state WHEN 'AVAILABLE' THEN reserved_order_id IS NULL
             WHEN 'RESERVED' THEN reserved_order_id IS NOT NULL
             WHEN 'SOLD' THEN reserved_order_id IS NOT NULL
             ELSE true END);
CREATE INDEX demo_credits_available ON demo_credits(batch_id, ordinal) WHERE state = 'AVAILABLE';

-- Credit lifecycle (extends 0002). Reserving needs an active hold by the owning order; selling needs that order to be payable;
-- releasing needs the hold to have been deactivated first. The owner cannot change while the state stays the same.
CREATE OR REPLACE FUNCTION guard_demo_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'AVAILABLE' THEN
      RAISE EXCEPTION 'a demo credit must be created AVAILABLE, not %', NEW.state USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'demo_credits rows cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.available_since IS DISTINCT FROM OLD.available_since THEN
    RAISE EXCEPTION 'a demo credit''s identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = OLD.state THEN
    IF NEW.reserved_order_id IS DISTINCT FROM OLD.reserved_order_id THEN
      RAISE EXCEPTION 'a credit''s owning order cannot change while its state stays %', OLD.state USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'AVAILABLE' AND NEW.state IN ('RESERVED', 'REVERSED'))
       OR (OLD.state = 'RESERVED'  AND NEW.state IN ('AVAILABLE', 'SOLD', 'REVERSED'))
       OR (OLD.state = 'SOLD'      AND NEW.state IN ('RETIRED', 'REVERSED'))) THEN
    RAISE EXCEPTION 'illegal demo credit transition % -> %', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state = 'AVAILABLE' AND NEW.state = 'RESERVED' THEN
    IF NOT EXISTS (SELECT 1 FROM demo_order_items WHERE credit_id = NEW.id AND order_id = NEW.reserved_order_id AND active) THEN
      RAISE EXCEPTION 'a credit can only be reserved while its order holds it (no active hold for this order)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF OLD.state = 'RESERVED' AND NEW.state = 'SOLD' THEN
    IF NEW.reserved_order_id IS DISTINCT FROM OLD.reserved_order_id THEN
      RAISE EXCEPTION 'a credit is sold to the order that holds it' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM demo_order_items WHERE credit_id = NEW.id AND order_id = NEW.reserved_order_id AND active) THEN
      RAISE EXCEPTION 'a credit can only be sold while its order holds it (no active hold for this order)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM demo_orders WHERE id = NEW.reserved_order_id AND state IN ('RESERVED','AWAITING_PAYMENT','REVALIDATING')) THEN
      RAISE EXCEPTION 'a credit can only be sold by an order in a payable state' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF OLD.state = 'RESERVED' AND NEW.state = 'AVAILABLE' THEN
    IF EXISTS (SELECT 1 FROM demo_order_items WHERE credit_id = NEW.id AND active) THEN
      RAISE EXCEPTION 'a credit cannot be released while an order still holds it (deactivate the hold first)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION guard_demo_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('CREATED','RESERVED') THEN
      RAISE EXCEPTION 'an order is created CREATED or RESERVED, not %', NEW.state USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'demo_orders rows cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.commission_bps IS DISTINCT FROM OLD.commission_bps OR NEW.tax_rule IS DISTINCT FROM OLD.tax_rule
     OR NEW.unit_price_paise IS DISTINCT FROM OLD.unit_price_paise OR NEW.price_effective_from IS DISTINCT FROM OLD.price_effective_from THEN
    RAISE EXCEPTION 'an order''s identity and price snapshot are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('FULFILLED','REFUNDED') THEN
    RAISE EXCEPTION 'illegal order transition % -> % (final state)', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'CREATED' AND NEW.state IN ('RESERVED','CANCELLED'))
       OR (OLD.state IN ('RESERVED','AWAITING_PAYMENT') AND NEW.state IN ('AWAITING_PAYMENT','RESERVED','CANCELLED','EXPIRED','FULFILLED','REVALIDATING') AND NEW.state <> OLD.state)
       OR (OLD.state IN ('EXPIRED','CANCELLED') AND NEW.state = 'REVALIDATING')
       OR (OLD.state = 'REVALIDATING' AND NEW.state IN ('FULFILLED','REFUND_PENDING'))
       OR (OLD.state = 'REFUND_PENDING' AND NEW.state = 'REFUNDED')) THEN
    RAISE EXCEPTION 'illegal order transition % -> %', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_orders_guard BEFORE INSERT OR UPDATE OR DELETE ON demo_orders FOR EACH ROW EXECUTE FUNCTION guard_demo_order();

-- An order and its credits live in different tables, so neither row-level guard can see the other. This deferred trigger runs at
-- commit and refuses a FULFILLED order whose holds, credits, ledger and totals do not agree.
CREATE FUNCTION check_order_fulfilled() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held integer; ledger integer; gross numeric; wrong integer;
BEGIN
  SELECT count(*) INTO held FROM demo_order_items WHERE order_id = NEW.id AND active;
  IF held <> NEW.allocated_quantity THEN
    RAISE EXCEPTION 'fulfilled order % holds % credits but allocated %', NEW.id, held, NEW.allocated_quantity USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT count(*) INTO wrong FROM demo_order_items i JOIN demo_credits c ON c.id = i.credit_id
    WHERE i.order_id = NEW.id AND i.active AND (c.state <> 'SOLD' OR c.reserved_order_id IS DISTINCT FROM NEW.id);
  IF wrong > 0 THEN
    RAISE EXCEPTION 'fulfilled order % has % credits that are not sold to it', NEW.id, wrong USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT count(*), coalesce(sum(gross_paise), 0) INTO ledger, gross FROM demo_ledger_entries WHERE order_id = NEW.id;
  IF ledger <> NEW.allocated_quantity OR gross <> NEW.principal_paise THEN
    RAISE EXCEPTION 'fulfilled order % ledger (% rows, % paise) does not match % credits and % paise', NEW.id, ledger, gross, NEW.allocated_quantity, NEW.principal_paise USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER demo_orders_fulfilled_check AFTER INSERT OR UPDATE ON demo_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'FULFILLED') EXECUTE FUNCTION check_order_fulfilled();

CREATE FUNCTION guard_demo_order_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order items cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id
     OR NEW.credit_id IS DISTINCT FROM OLD.credit_id OR NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.generation IS DISTINCT FROM OLD.generation THEN
    RAISE EXCEPTION 'order items are immutable except for deactivation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.active AND NOT OLD.active THEN
    RAISE EXCEPTION 'a deactivated hold is never reactivated; a new generation is inserted instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_order_items_guard BEFORE UPDATE OR DELETE ON demo_order_items FOR EACH ROW EXECUTE FUNCTION guard_demo_order_item();

-- Payment attempts: SUCCEEDED is absorbing. A FAILED or CANCELLED attempt can still become SUCCEEDED because the money may
-- have been captured (late or out-of-order provider events), but a failure never regresses a success.
CREATE FUNCTION guard_demo_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('CREATED','PENDING') THEN
      RAISE EXCEPTION 'a payment attempt is created CREATED or PENDING, not %', NEW.state USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment attempts cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id
     OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref
     OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash THEN
    RAISE EXCEPTION 'a payment attempt''s identity and amount are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state = 'SUCCEEDED' THEN
    RAISE EXCEPTION 'illegal payment attempt transition % -> % (success is final)', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'CREATED' AND NEW.state IN ('PENDING','FAILED','CANCELLED','SUCCEEDED'))
       OR (OLD.state = 'PENDING' AND NEW.state IN ('SUCCEEDED','FAILED','CANCELLED'))
       OR (OLD.state IN ('FAILED','CANCELLED') AND NEW.state = 'SUCCEEDED')) THEN
    RAISE EXCEPTION 'illegal payment attempt transition % -> %', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_payment_attempts_guard BEFORE INSERT OR UPDATE OR DELETE ON demo_payment_attempts FOR EACH ROW EXECUTE FUNCTION guard_demo_payment_attempt();

CREATE FUNCTION guard_demo_payment_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refunds cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise THEN
    RAISE EXCEPTION 'a refund''s identity and amount are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state = 'REFUNDED' AND NEW.state <> 'REFUNDED' THEN
    RAISE EXCEPTION 'a settled refund is final' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state = 'PENDING' AND NEW.state = 'REFUNDED' THEN
    NEW.settled_at := now();
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_payment_refunds_guard BEFORE UPDATE OR DELETE ON demo_payment_refunds FOR EACH ROW EXECUTE FUNCTION guard_demo_payment_refund();
