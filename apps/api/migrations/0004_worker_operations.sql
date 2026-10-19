-- 0004_worker_operations: what the worker needs to be operable.
--   * demo_chain_proofs.failure_count: consecutive failures, drives backoff and the bounded-retry rule. Reset on progress.
--     (attempts keeps counting every observation, including routine polling.)
--   * demo_chain_proofs.created_at: lets operations measure how long a proof has been unfinished.
--   * a partial index for the worker's "what is due" query, which never needs terminal FAILED rows.
--   * worker_heartbeat: one row per worker process name, so an external monitor (or SQL) can tell a worker is alive.

ALTER TABLE demo_chain_proofs ADD COLUMN failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0);
ALTER TABLE demo_chain_proofs ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX demo_chain_proofs_due ON demo_chain_proofs(next_attempt_at) WHERE status <> 'FAILED';

CREATE TABLE worker_heartbeat (
  name text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  beat_at timestamptz NOT NULL,
  cycles bigint NOT NULL DEFAULT 0 CHECK (cycles >= 0),
  failures bigint NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_result text,
  last_error_code text
);
