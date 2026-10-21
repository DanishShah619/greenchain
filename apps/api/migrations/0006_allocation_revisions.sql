-- 0006_allocation_revisions: an order can be allocated more than once before it reserves anything (a shortfall offer, then
-- accept-partial, possibly a fresh shortfall if supply changed in between). Each allocation is kept as its own immutable revision.
ALTER TABLE demo_allocation_log DROP CONSTRAINT demo_allocation_log_pkey;
ALTER TABLE demo_allocation_log ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE demo_allocation_log ADD PRIMARY KEY (order_id, revision);
ALTER TABLE demo_allocation_log ALTER COLUMN revision DROP DEFAULT;
