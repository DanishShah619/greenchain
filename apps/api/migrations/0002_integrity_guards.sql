-- 0002_integrity_guards: database-level guards for rules that were enforced only in application code.
--   1. review_decisions is immutable (the verifier's evidence decision and its snapshot are evidence).
--   2. demo_credits can only move along legal lifecycle transitions and cannot be deleted or re-identified.
--   3. demo_chain_proofs.status must be consistent with the columns that status implies.
-- Reserved for later migrations: a FROZEN credit state (disputes) must extend guard_demo_credit() when it is introduced.

-- Generic append-only guard (the older prevent_*_mutation functions carry table-specific messages).
CREATE FUNCTION prevent_row_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END; $$;

CREATE TRIGGER review_decisions_immutable BEFORE UPDATE OR DELETE ON review_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_row_mutation();

-- Credit lifecycle. Terminal states (RETIRED, REVERSED) never change again.
--   AVAILABLE -> RESERVED | REVERSED
--   RESERVED  -> AVAILABLE | SOLD | REVERSED      (AVAILABLE = reservation released)
--   SOLD      -> RETIRED | REVERSED
CREATE FUNCTION guard_demo_credit() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.quantity IS DISTINCT FROM OLD.quantity THEN
    RAISE EXCEPTION 'a demo credit''s identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'AVAILABLE' AND NEW.state IN ('RESERVED', 'REVERSED'))
       OR (OLD.state = 'RESERVED'  AND NEW.state IN ('AVAILABLE', 'SOLD', 'REVERSED'))
       OR (OLD.state = 'SOLD'      AND NEW.state IN ('RETIRED', 'REVERSED'))) THEN
    RAISE EXCEPTION 'illegal demo credit transition % -> %', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER demo_credits_guard BEFORE INSERT OR UPDATE OR DELETE ON demo_credits
  FOR EACH ROW EXECUTE FUNCTION guard_demo_credit();

-- A proof's status implies which columns are filled. Written as a CASE so each status is stated once.
-- Added without NOT VALID on purpose: if any existing row violates it, this migration fails loudly instead of leaving bad data.
ALTER TABLE demo_chain_proofs ADD CONSTRAINT demo_chain_proofs_status_columns CHECK (
  attempts >= 0 AND confirmations >= 0 AND
  CASE status
    -- not yet prepared: nothing about a transaction exists
    WHEN 'QUEUED' THEN raw_transaction IS NULL AND transaction_hash IS NULL AND nonce IS NULL
    -- signed bytes, hash and nonce are persisted before any broadcast
    WHEN 'PREPARED' THEN network IS NOT NULL AND contract_address IS NOT NULL AND signer_address IS NOT NULL
                         AND nonce IS NOT NULL AND raw_transaction IS NOT NULL AND transaction_hash IS NOT NULL
    -- broadcast or observed on chain: a transaction hash and a known target
    WHEN 'PENDING' THEN network IS NOT NULL AND contract_address IS NOT NULL AND signer_address IS NOT NULL
                        AND transaction_hash IS NOT NULL
    -- uncertain outcome: the target is known; a hash may be absent if the effect was found without our transaction
    WHEN 'RECONCILING' THEN network IS NOT NULL AND contract_address IS NOT NULL AND signer_address IS NOT NULL
    WHEN 'CONFIRMED' THEN network IS NOT NULL AND contract_address IS NOT NULL AND signer_address IS NOT NULL
                          AND transaction_hash IS NOT NULL AND block_number IS NOT NULL AND block_hash IS NOT NULL
    -- terminal failure always says why
    WHEN 'FAILED' THEN last_error IS NOT NULL
    ELSE false
  END
);
