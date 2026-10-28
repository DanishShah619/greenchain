-- 0012_retirement: credit retirement and the retirement certificate (docs/25).
--   * demo_retirements / demo_retirement_items: who retired which SOLD credits, for which reporting period (insert-only);
--   * demo_retirement_certificates: one frozen, hashed certificate per retirement (insert-only);
--   * a credit becomes RETIRED (terminal, already in the credit guard) only together with its retirement record.
-- Retiring moves no money: the ledger, journals and payouts are untouched.

CREATE TABLE demo_retirements (
  id uuid PRIMARY KEY,
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),
  buyer_id text NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  reporting_period text NOT NULL CHECK (reporting_period ~ '^(FY20[2-9][0-9]-[0-9]{2}|20[2-9][0-9])$'),
  purpose text CHECK (purpose IS NULL OR char_length(purpose) BETWEEN 1 AND 120),
  credit_count integer NOT NULL CHECK (credit_count BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, buyer_id, request_id),
  UNIQUE (id, scenario_id)
);
CREATE INDEX demo_retirements_buyer ON demo_retirements(scenario_id, buyer_id, created_at DESC);
CREATE TRIGGER demo_retirements_not_retired BEFORE INSERT ON demo_retirements FOR EACH ROW EXECUTE FUNCTION refuse_in_retired_scenario();
CREATE TRIGGER demo_retirements_immutable BEFORE UPDATE OR DELETE ON demo_retirements FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

CREATE TABLE demo_retirement_items (
  retirement_id uuid NOT NULL,
  scenario_id text NOT NULL,
  credit_id text NOT NULL UNIQUE REFERENCES demo_credits(id),
  PRIMARY KEY (retirement_id, credit_id),
  FOREIGN KEY (retirement_id, scenario_id) REFERENCES demo_retirements(id, scenario_id)
);
-- An item names a SOLD credit bought, through a FULFILLED order of the same scenario, by the buyer who retires it.
CREATE FUNCTION guard_demo_retirement_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM demo_credits c JOIN demo_orders o ON o.id = c.reserved_order_id JOIN demo_retirements r ON r.id = NEW.retirement_id
                 WHERE c.id = NEW.credit_id AND c.state = 'SOLD' AND o.state = 'FULFILLED' AND o.buyer_id = r.buyer_id AND o.scenario_id = NEW.scenario_id) THEN
    RAISE EXCEPTION 'credit % is not a SOLD credit of the retiring buyer', NEW.credit_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_retirement_items_guard BEFORE INSERT ON demo_retirement_items FOR EACH ROW EXECUTE FUNCTION guard_demo_retirement_item();
CREATE TRIGGER demo_retirement_items_immutable BEFORE UPDATE OR DELETE ON demo_retirement_items FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

-- A retirement names exactly credit_count credits, checked at commit.
CREATE FUNCTION check_retirement_size() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM demo_retirement_items WHERE retirement_id = NEW.id;
  IF n <> NEW.credit_count THEN
    RAISE EXCEPTION 'retirement % declares % credits but has %', NEW.id, NEW.credit_count, n USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER demo_retirements_size AFTER INSERT ON demo_retirements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_retirement_size();

-- SOLD -> RETIRED only together with the credit's retirement item (the credit guard already makes RETIRED terminal).
CREATE FUNCTION guard_credit_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM demo_retirement_items WHERE credit_id = NEW.id) THEN
    RAISE EXCEPTION 'credit % can be retired only with its retirement record', NEW.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_credits_retirement BEFORE UPDATE ON demo_credits FOR EACH ROW
  WHEN (NEW.state = 'RETIRED' AND OLD.state IS DISTINCT FROM 'RETIRED') EXECUTE FUNCTION guard_credit_retirement();

CREATE TABLE demo_retirement_certificates (
  retirement_id uuid PRIMARY KEY,
  scenario_id text NOT NULL,
  number text NOT NULL UNIQUE CHECK (number ~ '^GC-RETIRE-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  content jsonb NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (retirement_id, scenario_id) REFERENCES demo_retirements(id, scenario_id)
);
CREATE TRIGGER demo_retirement_certificates_immutable BEFORE UPDATE OR DELETE ON demo_retirement_certificates FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();
