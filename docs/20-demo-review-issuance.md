# Exact calculation review and demo issuance

Implemented 2026-10-14. Separate from production issuance, recognised credits, settlement and blockchain minting.

## Workflow

Agent creates a synthetic calculation after evidence approval. Each new input result becomes the current review candidate with an increasing generation. Matching calculation retries do not create or reselect a result. The agent may explicitly submit a historical, unreviewed saved scenario as the candidate; this increments the generation and records an audit event without changing the result. This supports comparing fixture scenarios while giving the verifier one exact candidate to review.

In Institution verifier, open the case and its calculation. Review the trace, input hash, buffer and confidence, enter a reason, then **Approve and issue demo units** or **Reject calculation**. The reviewer must hold the case's scenario/institution mandate and must differ from the calculation creator. Case evidence must remain approved and match its snapshot. The submitted generation and input hash must match the candidate. A `NEEDS_VISIT` outcome cannot be approved. Rejection records an immutable decision and produces no issuance; the agent can calculate or submit a different unreviewed scenario.

Approval pins one basis per case. Review, basis pointer, issuance batch, credit IDs, buffer/carry records, audit and a registry outbox event commit together through an internal registry port using the caller's transaction. No client-supplied credit amount endpoint exists. Case locking, unique constraints and stable review IDs protect duplicate/competing commands. An exact retry returns its saved decision; changed request content fails. After approval, new scenario calculations and candidate changes are blocked; historical reads and matching calculation replays remain available.

## Quantities and provenance

One demo credit is one tonne. The registry validates fixed-scale gross/buffer/net reconciliation. `credit_count = floor(net)`; `carry = net - credit_count`. A sub-tonne result creates an issuance batch with zero credits and a fractional carry record, not a fabricated whole credit. Zero net is valid and creates zero credits/carry. Buffer stays outside sale inventory. Carry is retained per source calculation/case and demo vintage 2026; it is not aggregated across cases or vintages in this slice.

Credit IDs are `DEMO-2026-<batch UUID>-<ordinal>`. Each row points to its batch, which pins case, calculation, review and input hash. Composite foreign keys bind the calculation and review to the same scope. Newly issued credits are `AVAILABLE`. The UI lists 50 IDs at a time with pagination, total whole units, withheld buffer and carry. Calculation/review/batch rows are immutable through the API and database mutation triggers; credit lifecycle operations remain future modules.

Registry events are durable intents only. Their identifiers, input hash and credit count are ready for a later proof worker. No chain RPC, NFT/token mint, sale, payout or recognised credit is created here. The UI reports blockchain proof as not submitted.

## Limits

This is synchronous synthetic approval plus internal issuance, not the production issuance-worker/cycle/rights-policy system. One case represents one demonstration source; cross-case duplicate plots and spatial overlap, verified ownership/payees, multi-vintage carry provenance, freezing/revocation/deltas and production registry gates remain pending. The separate demo tables and namespace checks must not be reused as production issuance.

Automated checks cover exact/stale candidate review, role separation, competing approvals, duplicate receipts, quantity conservation, zero/sub-tonne results, rejected/Needs-visit gates, immutable rows, mandate denial and rollback when outbox persistence fails. Embedded PostgreSQL concurrency checks are not a deployed multi-connection stress test. Manual PWA/device tests remain deferred by the user.

## Validation result

23 tests passed; targeted final review tests also passed after adding composite foreign keys. All workspace type checks and production builds passed. `node scripts/demo-issuance-smoke.mjs` completed a fresh live synthetic case and created exactly two unique demo credits, with 0.3268 t buffer and 0.9412 t carry-over. Duplicate approval replay and a second approval attempt produced no additional batch. Proof remains pending; no blockchain transaction was submitted.
