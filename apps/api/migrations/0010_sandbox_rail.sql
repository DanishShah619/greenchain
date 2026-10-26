-- 0010_sandbox_rail: the sandbox payout rail's own memory and call log (docs/23 P9), and one more attempt outcome.
-- These tables belong to the simulated rail, not to the ledger: application code reaches them only through the rail port,
-- and tests read the call log as an oracle (one processed transfer per settled payout, none for a cancelled one).

CREATE TABLE demo_sandbox_rail (
  payout_id uuid PRIMARY KEY,
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),
  account_token text NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  suffix text NOT NULL CHECK (suffix IN ('00','02','03','04','05','06','10','11','12')),
  -- NOT_PROCESSED: known key, nothing accepted. PENDING_LATE: accepted but not yet visible to lookups (suffix 11).
  status text NOT NULL CHECK (status IN ('NOT_PROCESSED','PENDING_LATE','PROCESSING','SETTLED','REJECTED','RETURNED','VOIDED')),
  ticks integer NOT NULL DEFAULT 0 CHECK (ticks >= 0),
  transient_failures integer NOT NULL DEFAULT 0 CHECK (transient_failures >= 0),
  settled_amount_paise bigint CHECK (settled_amount_paise > 0),
  rail_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demo_sandbox_rail_moving ON demo_sandbox_rail(scenario_id) WHERE status IN ('PENDING_LATE','PROCESSING');

CREATE TABLE demo_sandbox_calls (
  id bigserial PRIMARY KEY,
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),
  payout_id uuid,
  op text NOT NULL CHECK (op IN ('send','get','void','tick')),
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((op = 'tick') = (payout_id IS NULL))
);
CREATE INDEX demo_sandbox_calls_payout ON demo_sandbox_calls(payout_id, id) WHERE payout_id IS NOT NULL;
CREATE TRIGGER demo_sandbox_calls_immutable BEFORE UPDATE OR DELETE ON demo_sandbox_calls FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

-- CONFLICT: the rail knows this key with a different token or amount. Not a confirmation of non-payment.
ALTER TABLE demo_payout_attempts DROP CONSTRAINT demo_payout_attempts_class_check;
ALTER TABLE demo_payout_attempts ADD CONSTRAINT demo_payout_attempts_class_check
  CHECK (class IN ('ACCEPTED','SETTLED','TRANSIENT','REJECTED','RESOLVED_ABSENT','RESOLVED_FOUND','CONFLICT'));
