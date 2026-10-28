-- 0011_certificates_reset: purchase certificates and the safe presenter reset (docs/24).
--   * demo_certificates: one frozen certificate per FULFILLED order, insert-only;
--   * demo_scenario_resets: one row per reset request (replay-safe rotation);
--   * demo_namespaces.retired_at: a reset retires the old scenario. Nothing new starts in a retired scenario (orders, payout runs,
--     clock moves, config versions); work already in flight (late payments, payouts) still completes. Nothing is ever deleted.

-- Retired scenarios ------------------------------------------------------------------------------------------------------
ALTER TABLE demo_namespaces ADD COLUMN retired_at timestamptz;
CREATE FUNCTION guard_demo_namespace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scenario_id IS DISTINCT FROM OLD.scenario_id THEN
    RAISE EXCEPTION 'a demo namespace keeps its scenario' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'a retired scenario stays retired' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_namespaces_guard BEFORE UPDATE ON demo_namespaces FOR EACH ROW EXECUTE FUNCTION guard_demo_namespace();

CREATE FUNCTION refuse_in_retired_scenario() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM demo_namespaces WHERE scenario_id = NEW.scenario_id AND retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'scenario % is retired: nothing new starts there', NEW.scenario_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_orders_not_retired BEFORE INSERT ON demo_orders FOR EACH ROW EXECUTE FUNCTION refuse_in_retired_scenario();
CREATE TRIGGER demo_payout_batches_not_retired BEFORE INSERT ON demo_payout_batches FOR EACH ROW EXECUTE FUNCTION refuse_in_retired_scenario();
CREATE TRIGGER demo_ledger_config_not_retired BEFORE INSERT ON demo_ledger_config FOR EACH ROW EXECUTE FUNCTION refuse_in_retired_scenario();
CREATE TRIGGER demo_clock_not_retired BEFORE INSERT OR UPDATE ON demo_clock FOR EACH ROW EXECUTE FUNCTION refuse_in_retired_scenario();

-- Resets -----------------------------------------------------------------------------------------------------------------
CREATE TABLE demo_scenario_resets (
  request_id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  from_scenario text NOT NULL REFERENCES demo_namespaces(scenario_id),
  to_scenario text NOT NULL UNIQUE REFERENCES demo_namespaces(scenario_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_scenario <> to_scenario)
);
CREATE TRIGGER demo_scenario_resets_immutable BEFORE UPDATE OR DELETE ON demo_scenario_resets FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

-- Certificates -----------------------------------------------------------------------------------------------------------
-- The content hash is SHA-256 over canonical JSON, computed by the application (src/modules/market/domain/certificate.ts);
-- verification recomputes it from the stored content, so an edit that bypassed this guard is still detected.
CREATE TABLE demo_certificates (
  order_id uuid PRIMARY KEY,
  scenario_id text NOT NULL,
  number text NOT NULL UNIQUE CHECK (number ~ '^GC-DEMO-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  content jsonb NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, scenario_id) REFERENCES demo_orders(id, scenario_id)
);
CREATE FUNCTION guard_demo_certificate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM demo_orders WHERE id = NEW.order_id AND state = 'FULFILLED') THEN
    RAISE EXCEPTION 'a certificate is issued only for a FULFILLED order' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER demo_certificates_guard BEFORE INSERT ON demo_certificates FOR EACH ROW EXECUTE FUNCTION guard_demo_certificate();
CREATE TRIGGER demo_certificates_immutable BEFORE UPDATE OR DELETE ON demo_certificates FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();
