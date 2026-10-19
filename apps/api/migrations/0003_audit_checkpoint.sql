-- 0003_audit_checkpoint: make audit verification incremental and take chaining off a whole-table scan.
--   * audit_integrity_state: a singleton checkpoint (how far the chain has been verified, and whether verification ever failed).
--   * audit_chain_queue: events waiting to be chained, filled by a trigger, so the chainer reads O(batch) rows, not the whole log.
--   * indexes for the per-case audit read.
--   * demo_chain_proofs.anchor_verified_at: each confirmed anchor is checked once, when the checkpoint passes it.

CREATE TABLE audit_integrity_state (
  id integer PRIMARY KEY CHECK (id = 1),
  verified_seq bigint NOT NULL DEFAULT 0 CHECK (verified_seq >= 0),
  verified_hash text NOT NULL,
  status text NOT NULL DEFAULT 'OK' CHECK (status IN ('OK', 'FAILED')),
  failure_code text,
  failed_seq bigint,
  checked_at timestamptz,
  full_verified_at timestamptz,
  full_verified_seq bigint,
  CHECK ((status = 'FAILED') = (failure_code IS NOT NULL))
);
INSERT INTO audit_integrity_state(id, verified_hash) VALUES (1, repeat('0', 64));

-- The checkpoint only moves forward, and FAILED is sticky: it is cleared by an operator after investigation
-- (disable this trigger, reset the row, re-enable), never by the application.
CREATE FUNCTION guard_audit_integrity_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_integrity_state cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.verified_seq < OLD.verified_seq THEN
    RAISE EXCEPTION 'the audit verification checkpoint cannot move backwards' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'FAILED' AND NEW.status <> 'FAILED' THEN
    RAISE EXCEPTION 'a failed audit integrity state must be cleared by an operator, not by the application' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER audit_integrity_state_guard BEFORE UPDATE OR DELETE ON audit_integrity_state
  FOR EACH ROW EXECUTE FUNCTION guard_audit_integrity_state();

CREATE TABLE audit_chain_queue (
  event_id uuid PRIMARY KEY REFERENCES audit_events(id),
  created_at timestamptz NOT NULL
);
-- Events that exist today and are not chained yet.
INSERT INTO audit_chain_queue(event_id, created_at)
  SELECT a.id, a.created_at FROM audit_events a LEFT JOIN audit_chain_links l ON l.event_id = a.id WHERE l.event_id IS NULL;
CREATE FUNCTION enqueue_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_chain_queue(event_id, created_at) VALUES (NEW.id, NEW.created_at);
  RETURN NEW;
END; $$;
-- A trigger (not application code) so legacy and manual inserts are queued too.
CREATE TRIGGER audit_events_enqueue AFTER INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION enqueue_audit_event();
CREATE INDEX audit_chain_queue_order ON audit_chain_queue(created_at, event_id);

CREATE INDEX audit_events_case ON audit_events(scenario_id, capture_id, created_at DESC, id DESC);

ALTER TABLE demo_chain_proofs ADD COLUMN anchor_verified_at timestamptz;
