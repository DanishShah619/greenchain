-- 0007_hardening: fixes from the backend audit.
--   1. Evidence and plots freeze once a case leaves DRAFT (they are the basis of review, calculation and issuance).
--   2. review_cases follow their state machine in the database, not only in application code.
--   3. Indexes for the market's hot paths (several run inside the scenario lock).
--   4. An order's reservation timestamps must match its state, so a reservation can never become unreapable.
--   5. Dead letters for payment events whose apply keeps failing, so the provider stops retrying and an operator can act.

-- 1. Evidence and plots -------------------------------------------------------------------------------------------------
CREATE FUNCTION case_is_draft(p_scenario text, p_capture uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM review_cases WHERE scenario_id = p_scenario AND capture_id = p_capture AND state = 'DRAFT');
$$;

CREATE FUNCTION guard_plot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plots cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.scenario_id IS DISTINCT FROM OLD.scenario_id OR NEW.capture_id IS DISTINCT FROM OLD.capture_id) THEN
    RAISE EXCEPTION 'a plot cannot move to another case' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT case_is_draft(NEW.scenario_id, NEW.capture_id) THEN
    RAISE EXCEPTION 'a plot can only change while its case is DRAFT' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER plots_guard BEFORE INSERT OR UPDATE OR DELETE ON plots FOR EACH ROW EXECUTE FUNCTION guard_plot();

-- A finished upload always carries its validated preview, and an unfinished one never does.
ALTER TABLE evidence_uploads ADD CONSTRAINT evidence_uploads_preview CHECK ((status = 'COMPLETE') = (preview_data IS NOT NULL));

CREATE FUNCTION guard_evidence_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence uploads cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'UPLOADING' OR NOT case_is_draft(NEW.scenario_id, NEW.capture_id) THEN
      RAISE EXCEPTION 'evidence can only be started on a DRAFT case' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id OR NEW.capture_id IS DISTINCT FROM OLD.capture_id
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.slot IS DISTINCT FROM OLD.slot OR NEW.mime IS DISTINCT FROM OLD.mime
     OR NEW.size IS DISTINCT FROM OLD.size OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.filename IS DISTINCT FROM OLD.filename
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'evidence upload identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'COMPLETE' THEN
    RAISE EXCEPTION 'a finished evidence upload is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT case_is_draft(NEW.scenario_id, NEW.capture_id) THEN
    RAISE EXCEPTION 'evidence can only be finished on a DRAFT case' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER evidence_uploads_guard BEFORE INSERT OR UPDATE OR DELETE ON evidence_uploads FOR EACH ROW EXECUTE FUNCTION guard_evidence_upload();

CREATE FUNCTION guard_evidence_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'evidence chunks are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM evidence_uploads u WHERE u.id = NEW.upload_id AND u.status = 'UPLOADING' AND case_is_draft(u.scenario_id, u.capture_id)) THEN
    RAISE EXCEPTION 'evidence can only be added to an upload in progress on a DRAFT case' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER evidence_chunks_guard BEFORE INSERT OR UPDATE OR DELETE ON evidence_chunks FOR EACH ROW EXECUTE FUNCTION guard_evidence_chunk();

-- 2. Review case state machine -------------------------------------------------------------------------------------------
--   DRAFT -> SUBMITTED -> EVIDENCE_APPROVED | REJECTED. Only a DRAFT case is edited (version bumps); decided cases are final.
CREATE FUNCTION guard_review_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'a review case starts as DRAFT, not %', NEW.state USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'review cases cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.scenario_id IS DISTINCT FROM OLD.scenario_id OR NEW.capture_id IS DISTINCT FROM OLD.capture_id THEN
    RAISE EXCEPTION 'a review case identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'a review case version never decreases' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('EVIDENCE_APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'a decided review case is final (%)', OLD.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = OLD.state THEN
    IF OLD.state <> 'DRAFT' OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'a review case is only edited while DRAFT' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'DRAFT' AND NEW.state = 'SUBMITTED' AND NEW.submitted_at IS NOT NULL)
       OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('EVIDENCE_APPROVED', 'REJECTED') AND NEW.submitted_at IS NOT DISTINCT FROM OLD.submitted_at)) THEN
    RAISE EXCEPTION 'illegal review case transition % -> %', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER review_cases_guard BEFORE INSERT OR UPDATE OR DELETE ON review_cases FOR EACH ROW EXECUTE FUNCTION guard_review_case();

-- 3. Market indexes ------------------------------------------------------------------------------------------------------
-- Release, buyer limits, fulfilment and the invariants all look credits up by the order that holds them.
CREATE INDEX demo_credits_reserved_order ON demo_credits(reserved_order_id) WHERE reserved_order_id IS NOT NULL;
CREATE INDEX demo_payment_refunds_order ON demo_payment_refunds(order_id);
CREATE INDEX demo_payment_refunds_pending ON demo_payment_refunds(scenario_id, created_at) WHERE state = 'PENDING';
CREATE INDEX demo_payment_events_attempt ON demo_payment_events(attempt_id);
CREATE INDEX demo_orders_stale_offers ON demo_orders(scenario_id, created_at) WHERE state = 'CREATED';

-- 4. Reservation timestamps match the order state ------------------------------------------------------------------------
-- The reaper selects on reserved_until, so a holding order without one would keep its credits forever.
ALTER TABLE demo_orders ADD CONSTRAINT demo_orders_reservation_times CHECK (
  CASE state
    WHEN 'CREATED' THEN reserved_until IS NULL AND allocated_at IS NULL
    WHEN 'RESERVED' THEN reserved_until IS NOT NULL AND allocated_at IS NOT NULL
    WHEN 'AWAITING_PAYMENT' THEN reserved_until IS NOT NULL AND allocated_at IS NOT NULL
    WHEN 'FULFILLED' THEN allocated_at IS NOT NULL
    ELSE true
  END);

-- 5. Payment event dead letters ------------------------------------------------------------------------------------------
-- A delivery whose apply fails is rolled back and recorded here instead (separately from demo_payment_events, which only ever
-- holds applied events). After PAYMENT_MAX_EVENT_FAILURES the event is parked: the provider is told it was received, so it
-- stops retrying, and an operator retries it once the cause is fixed. The body is kept so the retry needs no provider.
CREATE TABLE demo_payment_event_failures (
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  attempt_id uuid NOT NULL REFERENCES demo_payment_attempts(id),
  scenario_id text NOT NULL,
  payload_hash text NOT NULL,
  body text NOT NULL CHECK (octet_length(body) <= 16384),
  failures integer NOT NULL CHECK (failures >= 1),
  last_code text NOT NULL,
  last_error_name text,
  last_error_code text,
  parked boolean NOT NULL DEFAULT false,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_failed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_event_id)
);
CREATE INDEX demo_payment_event_failures_parked ON demo_payment_event_failures(scenario_id, last_failed_at) WHERE parked;
