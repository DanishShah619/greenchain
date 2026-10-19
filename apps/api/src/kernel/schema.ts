export const schema = `
CREATE TABLE IF NOT EXISTS scenarios (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, scenario_id text NOT NULL REFERENCES scenarios(id),
  role text NOT NULL CHECK (role IN ('agent')), password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
  csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS captures (
  scenario_id text NOT NULL REFERENCES scenarios(id), event_id uuid NOT NULL,
  actor_id text NOT NULL, fingerprint text NOT NULL,
  farmer_label text NOT NULL, village text NOT NULL, area_hectares numeric(8,2) NOT NULL CHECK (area_hectares > 0),
  status text NOT NULL DEFAULT 'CAPTURED' CHECK (status = 'CAPTURED'),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (scenario_id, event_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY, scenario_id text NOT NULL, capture_id uuid NOT NULL,
  actor_id text NOT NULL, event_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (scenario_id,capture_id) REFERENCES captures(scenario_id,event_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY, scenario_id text NOT NULL, capture_id uuid NOT NULL,
  type text NOT NULL CHECK (type = 'capture.received'), processed_at timestamptz,
  FOREIGN KEY (scenario_id,capture_id) REFERENCES captures(scenario_id,event_id),
  UNIQUE (scenario_id,capture_id,type)
);
CREATE INDEX IF NOT EXISTS captures_list ON captures(scenario_id,created_at DESC,event_id);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(id) WHERE processed_at IS NULL;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS onboarding jsonb;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('agent','verifier'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS institution_id text NOT NULL DEFAULT 'demo-institution';
ALTER TABLE captures ADD COLUMN IF NOT EXISTS institution_id text NOT NULL DEFAULT 'demo-institution';
CREATE TABLE IF NOT EXISTS review_mandates (
  user_id text NOT NULL REFERENCES users(id), scenario_id text NOT NULL REFERENCES scenarios(id), institution_id text NOT NULL,
  PRIMARY KEY(user_id,scenario_id,institution_id)
);
CREATE TABLE IF NOT EXISTS review_cases (
  scenario_id text NOT NULL, capture_id uuid NOT NULL, version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','SUBMITTED','EVIDENCE_APPROVED','REJECTED')),
  submitted_at timestamptz, PRIMARY KEY(scenario_id,capture_id),
  FOREIGN KEY(scenario_id,capture_id) REFERENCES captures(scenario_id,event_id)
);
INSERT INTO review_cases(scenario_id,capture_id) SELECT scenario_id,event_id FROM captures ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS plots (
  scenario_id text NOT NULL, capture_id uuid NOT NULL, boundary jsonb NOT NULL, area_hectares numeric(12,4) NOT NULL,
  PRIMARY KEY(scenario_id,capture_id), FOREIGN KEY(scenario_id,capture_id) REFERENCES captures(scenario_id,event_id)
);
CREATE TABLE IF NOT EXISTS boundary_receipts (
  scenario_id text NOT NULL, capture_id uuid NOT NULL, request_id uuid NOT NULL, fingerprint text NOT NULL,
  result jsonb NOT NULL, PRIMARY KEY(scenario_id,capture_id,request_id),
  FOREIGN KEY(scenario_id,capture_id) REFERENCES captures(scenario_id,event_id)
);
CREATE TABLE IF NOT EXISTS evidence_uploads (
  id uuid PRIMARY KEY, scenario_id text NOT NULL, capture_id uuid NOT NULL, actor_id text NOT NULL,
  slot text NOT NULL CHECK(slot IN ('land_rights','plot_photo')), mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg')),
  size integer NOT NULL CHECK(size>0 AND size<=2097152), sha256 text NOT NULL, filename text NOT NULL,
  status text NOT NULL DEFAULT 'UPLOADING' CHECK(status IN ('UPLOADING','COMPLETE')),
  preview_data bytea, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(scenario_id,capture_id) REFERENCES captures(scenario_id,event_id), UNIQUE(scenario_id,capture_id,slot)
);
CREATE TABLE IF NOT EXISTS evidence_chunks (
  upload_id uuid NOT NULL REFERENCES evidence_uploads(id), chunk_index integer NOT NULL CHECK(chunk_index>=0 AND chunk_index<8),
  data bytea NOT NULL, sha256 text NOT NULL, PRIMARY KEY(upload_id,chunk_index)
);
CREATE TABLE IF NOT EXISTS review_decisions (
  id uuid PRIMARY KEY, scenario_id text NOT NULL, capture_id uuid NOT NULL, reviewer_id text NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK(decision IN ('EVIDENCE_APPROVED','REJECTED')), reason text NOT NULL, fingerprint text NOT NULL,
  snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(scenario_id,capture_id) REFERENCES captures(scenario_id,event_id), UNIQUE(scenario_id,capture_id)
);
CREATE INDEX IF NOT EXISTS review_queue ON review_cases(scenario_id,state,submitted_at,capture_id);
CREATE TABLE IF NOT EXISTS demo_namespaces (scenario_id text PRIMARY KEY REFERENCES scenarios(id));
CREATE TABLE IF NOT EXISTS demo_calculation_runs (
  id uuid PRIMARY KEY, scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id), capture_id uuid NOT NULL,
  actor_id text NOT NULL, evidence_decision_id uuid NOT NULL REFERENCES review_decisions(id),
  namespace text NOT NULL DEFAULT 'DEMO_ONLY' CHECK(namespace='DEMO_ONLY'),
  methodology_version text NOT NULL, parameter_version text NOT NULL, preset text NOT NULL,
  inputs_hash text NOT NULL, inputs jsonb NOT NULL, result jsonb NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('CALCULATED','NEEDS_VISIT')), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(scenario_id,capture_id) REFERENCES captures(scenario_id,event_id), UNIQUE(scenario_id,capture_id,inputs_hash)
);
CREATE TABLE IF NOT EXISTS demo_calculation_receipts (
  scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),actor_id text NOT NULL,request_id uuid NOT NULL,
  request_hash text NOT NULL,run_id uuid NOT NULL REFERENCES demo_calculation_runs(id),PRIMARY KEY(scenario_id,actor_id,request_id)
);
CREATE OR REPLACE FUNCTION prevent_demo_run_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Demo calculation runs are immutable'; END; $$;
DROP TRIGGER IF EXISTS demo_runs_immutable ON demo_calculation_runs;
CREATE TRIGGER demo_runs_immutable BEFORE UPDATE OR DELETE ON demo_calculation_runs FOR EACH ROW EXECUTE FUNCTION prevent_demo_run_mutation();
CREATE TABLE IF NOT EXISTS demo_calculation_state (
  scenario_id text NOT NULL,capture_id uuid NOT NULL,active_run_id uuid NOT NULL REFERENCES demo_calculation_runs(id),
  generation integer NOT NULL DEFAULT 1,approved_review_id uuid,PRIMARY KEY(scenario_id,capture_id),
  FOREIGN KEY(scenario_id,capture_id) REFERENCES captures(scenario_id,event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS demo_run_scope ON demo_calculation_runs(id,scenario_id,capture_id);
INSERT INTO demo_calculation_state(scenario_id,capture_id,active_run_id)
  SELECT DISTINCT ON(scenario_id,capture_id) scenario_id,capture_id,id FROM demo_calculation_runs
  ORDER BY scenario_id,capture_id,created_at DESC,id DESC ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS demo_calculation_reviews (
  id uuid PRIMARY KEY,scenario_id text NOT NULL,capture_id uuid NOT NULL,run_id uuid NOT NULL UNIQUE REFERENCES demo_calculation_runs(id),
  reviewer_id text NOT NULL REFERENCES users(id),decision text NOT NULL CHECK(decision IN ('APPROVED','REJECTED')),
  reason text NOT NULL,inputs_hash text NOT NULL,generation integer NOT NULL,request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(scenario_id,capture_id) REFERENCES captures(scenario_id,event_id),
  FOREIGN KEY(run_id,scenario_id,capture_id) REFERENCES demo_calculation_runs(id,scenario_id,capture_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS demo_review_scope ON demo_calculation_reviews(id,scenario_id,capture_id,run_id);
CREATE UNIQUE INDEX IF NOT EXISTS demo_one_approved_basis ON demo_calculation_reviews(scenario_id,capture_id) WHERE decision='APPROVED';
DROP TRIGGER IF EXISTS demo_reviews_immutable ON demo_calculation_reviews;
CREATE TRIGGER demo_reviews_immutable BEFORE UPDATE OR DELETE ON demo_calculation_reviews FOR EACH ROW EXECUTE FUNCTION prevent_demo_run_mutation();
CREATE TABLE IF NOT EXISTS demo_issuance_batches (
  id uuid PRIMARY KEY,scenario_id text NOT NULL REFERENCES demo_namespaces(scenario_id),capture_id uuid NOT NULL,run_id uuid NOT NULL UNIQUE REFERENCES demo_calculation_runs(id),
  review_id uuid NOT NULL UNIQUE REFERENCES demo_calculation_reviews(id),namespace text NOT NULL DEFAULT 'DEMO_ONLY' CHECK(namespace='DEMO_ONLY'),
  vintage integer NOT NULL CHECK(vintage=2026),gross_co2e numeric(12,4) NOT NULL CHECK(gross_co2e>=0),
  buffer_co2e numeric(12,4) NOT NULL CHECK(buffer_co2e>=0),net_co2e numeric(12,4) NOT NULL CHECK(net_co2e>=0),
  credit_count integer NOT NULL CHECK(credit_count>=0),carry_co2e numeric(12,4) NOT NULL CHECK(carry_co2e>=0 AND carry_co2e<1),
  inputs_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(scenario_id,capture_id),
  FOREIGN KEY(scenario_id,capture_id) REFERENCES captures(scenario_id,event_id),
  FOREIGN KEY(review_id,scenario_id,capture_id,run_id) REFERENCES demo_calculation_reviews(id,scenario_id,capture_id,run_id),
  CHECK(gross_co2e=buffer_co2e+net_co2e),CHECK(net_co2e=credit_count+carry_co2e)
);
DROP TRIGGER IF EXISTS demo_batches_immutable ON demo_issuance_batches;
CREATE TRIGGER demo_batches_immutable BEFORE UPDATE OR DELETE ON demo_issuance_batches FOR EACH ROW EXECUTE FUNCTION prevent_demo_run_mutation();
CREATE TABLE IF NOT EXISTS demo_credits (
  id text PRIMARY KEY,batch_id uuid NOT NULL REFERENCES demo_issuance_batches(id),ordinal integer NOT NULL,
  quantity numeric(12,4) NOT NULL DEFAULT 1 CHECK(quantity=1),state text NOT NULL DEFAULT 'AVAILABLE' CHECK(state IN ('AVAILABLE','RESERVED','SOLD','RETIRED','REVERSED')),
  UNIQUE(batch_id,ordinal)
);
CREATE TABLE IF NOT EXISTS demo_registry_events (
  id uuid PRIMARY KEY,batch_id uuid NOT NULL UNIQUE REFERENCES demo_issuance_batches(id),event_type text NOT NULL,payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz
);
CREATE TABLE IF NOT EXISTS demo_candidate_receipts (
  scenario_id text NOT NULL,actor_id text NOT NULL,request_id uuid NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,
  PRIMARY KEY(scenario_id,actor_id,request_id)
);
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS signed_record jsonb;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS row_mac text;
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit history is append-only'; END; $$;
DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TABLE IF NOT EXISTS audit_chain_state (
  id integer PRIMARY KEY CHECK(id=1),head_seq bigint NOT NULL DEFAULT 0,head_hash text NOT NULL,fence bigint NOT NULL DEFAULT 0
);
INSERT INTO audit_chain_state(id,head_hash) VALUES(1,repeat('0',64)) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS audit_chain_links (
  chain_seq bigint PRIMARY KEY,event_id uuid NOT NULL UNIQUE REFERENCES audit_events(id),previous_hash text NOT NULL,head_hash text NOT NULL,
  signed_record jsonb NOT NULL,row_mac text NOT NULL,fence bigint NOT NULL,chained_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS audit_links_immutable ON audit_chain_links;
CREATE TRIGGER audit_links_immutable BEFORE UPDATE OR DELETE ON audit_chain_links FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TABLE IF NOT EXISTS chain_worker_lease (
  id integer PRIMARY KEY CHECK(id=1),owner uuid,fence bigint NOT NULL DEFAULT 0,expires_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO chain_worker_lease(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS demo_chain_proofs (
  event_id uuid PRIMARY KEY REFERENCES demo_registry_events(id),batch_id uuid NOT NULL UNIQUE REFERENCES demo_issuance_batches(id),
  commitment text NOT NULL,anchor_seq bigint NOT NULL,anchor_hash text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','PREPARED','PENDING','CONFIRMED','RECONCILING','FAILED')),
  network integer,contract_address text,contract_version integer NOT NULL DEFAULT 1,signer_address text,nonce bigint,
  raw_transaction text,transaction_hash text,block_number bigint,block_hash text,confirmations integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,last_error text,next_attempt_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS chain_signer_nonce ON demo_chain_proofs(network,signer_address,nonce) WHERE nonce IS NOT NULL;
CREATE OR REPLACE FUNCTION protect_proof_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_id<>OLD.event_id OR NEW.batch_id<>OLD.batch_id OR NEW.commitment<>OLD.commitment OR NEW.anchor_seq<>OLD.anchor_seq OR NEW.anchor_hash<>OLD.anchor_hash OR NEW.contract_version<>OLD.contract_version THEN RAISE EXCEPTION 'Proof intent is immutable'; END IF;
  IF OLD.network IS NOT NULL AND (NEW.network IS DISTINCT FROM OLD.network OR NEW.contract_address IS DISTINCT FROM OLD.contract_address OR NEW.signer_address IS DISTINCT FROM OLD.signer_address) THEN RAISE EXCEPTION 'Proof target is immutable'; END IF;
  IF OLD.raw_transaction IS NOT NULL AND (NEW.raw_transaction IS DISTINCT FROM OLD.raw_transaction OR NEW.nonce IS DISTINCT FROM OLD.nonce OR NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash) THEN RAISE EXCEPTION 'Prepared proof transaction is immutable'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS proof_intent_immutable ON demo_chain_proofs;
CREATE TRIGGER proof_intent_immutable BEFORE UPDATE ON demo_chain_proofs FOR EACH ROW EXECUTE FUNCTION protect_proof_intent();
DROP TRIGGER IF EXISTS proof_jobs_no_delete ON demo_chain_proofs;
CREATE TRIGGER proof_jobs_no_delete BEFORE DELETE ON demo_chain_proofs FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE OR REPLACE FUNCTION protect_registry_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.batch_id<>OLD.batch_id OR NEW.event_type<>OLD.event_type OR NEW.payload<>OLD.payload OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'Registry effect is immutable'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS registry_events_immutable ON demo_registry_events;
CREATE TRIGGER registry_events_immutable BEFORE UPDATE ON demo_registry_events FOR EACH ROW EXECUTE FUNCTION protect_registry_event();
DROP TRIGGER IF EXISTS registry_events_no_delete ON demo_registry_events;
CREATE TRIGGER registry_events_no_delete BEFORE DELETE ON demo_registry_events FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
`;
