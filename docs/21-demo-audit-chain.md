# Demo audit chain and Amoy proofs

The local MVP signs new audit events in each business transaction, commits a SHA-256 hash chain, and queues a blockchain commitment for each approved demo issuance. The Solidity registry is a provenance service for synthetic quantities. It does not mint recognised carbon credits or transfer tokens.

## Audit integrity

`appendAudit` stores a versioned HMAC-SHA256 record with keyed scope, actor and entity pseudonyms, event ID, action, timestamp and safe reference fingerprint. Farmer labels, consent text and evidence bytes never enter the signed record or chain calldata. Existing unsigned events receive `LEGACY_BACKFILL` records when chained; this does not establish their integrity before migration.

The chainer locks one state row throughout its database transaction. That lock fences all chain writes, and sequence numbers advance only on commit. It reads committed events, verifies MACs, and writes immutable links. Sequence order is commitment order; timestamps remain occurrence metadata. It makes no claim that insertion gaps reveal tampering.

Database triggers prohibit updates/deletes of events and links. Verification checks signed row metadata, MACs, contiguous committed links, head state, and locally recorded confirmed anchor heads. It is **incremental**: the worker verifies only the links added since a stored checkpoint (`audit_integrity_state`), so the cost of a cycle depends on new events, not on history, and there is no event-count ceiling. Newly appended events are queued for chaining by a database trigger, so the chainer reads only its queue. A full re-verification from genesis (`verifyAuditFull`, streamed in batches) is the only check that detects tampering with rows already behind the checkpoint; run it periodically or on demand, off the request path. Any integrity finding sets a **sticky FAILED state**: chaining stops, no proof is queued, and the worker halts cleanly (`HALTED_INTEGRITY`) until an operator investigates and clears the state. A proof is only anchored to a head the checkpoint already covers. `GET /api/v1/cases/:id/audit` requires case ownership or reviewer mandate and returns the most recent 100 case events plus a **case-scoped** integrity summary (this case's events: total, committed, verified; its latest committed event). It deliberately exposes no global sequence, head hash, or counts, which would reveal other scenarios' activity, and no raw signed payloads or keys.

An unchained deletion or an unwitnessed tail deletion needs an independent witness. A privileged database administrator can disable triggers; an administrator controlling both the database and signing keys exceeds this demo's threat model. Back up the signing key separately from the database. Versioned migrations, separate database grants, KMS signing/key rotation and independent durable receipts are still hosting requirements.

## Issuance proof worker

The approval transaction commits the immutable batch, demo units, balances, audit event and registry outbox together. Later, the worker waits until the case's audit events are chained and prepares a batch commitment binding the exact calculation/review IDs, input hash, vintage, gross/buffer/net/carry quantities, unit count and deterministic credit ID rule. On-chain calldata contains only the effect fingerprint, batch commitment, audit sequence and audit head.

`DemoProofRegistry.sol` accepts its immutable writer only. Matching effect replay creates no second record or event; changed commitments and conflicting heads are rejected. Each proof also anchors its audit head. The registry version is pinned to 1.

Proof processing uses a fenced, 90-second database lease for one dedicated signer. Signed transaction bytes, hash, nonce, chain, contract and signer are persisted before broadcasting. Restart, timeout and unknown submission reconcile the existing effect/receipt first and reuse the same signed bytes. Unresolved prepared jobs block signing later jobs; there is no automatic fresh-nonce replacement. Use a dedicated testnet signer with no other writers.

The Amoy factory pins chain ID 80002. It checks runtime contract code hash, version and writer; rejects another chain/contract/signer; allows only `recordProof` with zero value; caps gas at 200,000 and configured fees at at most 200 gwei. Private keys are read from a server file and never sent to the browser. RPC errors are reduced to safe codes.

Status is `NOT_CONFIGURED` in the UI while the optional service is unset; the durable intent remains queued. Configured jobs progress through `QUEUED`, `PREPARED`, `PENDING` and `CONFIRMED`; uncertain or conflicting outcomes become `RECONCILING`, and reverted receipts become `FAILED`. Confirmation requires a successful receipt, matching effect/head, canonical block hash and the configured depth (default 12). Confirmed proofs are checked again; a missing/reorganised proof returns to pending or reconciliation. This never rolls back database issuance. These statuses are also returned by the authenticated issuance endpoint. Case detail includes a readable event history, historical backfill labels and an explicit status refresh.

**Failure handling.** Every chain-port call has a deadline (default 45 s) and the signer lease is renewed before it, so a hung RPC cannot hold the signer past its lease. A failed step stores a *safe error code* (for example `CHAIN_RPC_TIMEOUT`, `CHAIN_RPC_UNAVAILABLE`, `CHAIN_UNKNOWN`) and never the raw message, which can contain RPC URLs with keys. Failures increment `failure_count` and retry after a capped exponential delay with ±20% jitter. A proof with no signed transaction becomes `FAILED` after `PROOF_MAX_FAILURES` consecutive failures and is not retried until an operator runs `proofs requeue` (audited as `chain.proof.requeued`). A proof that has a signed transaction is never parked: it stays `RECONCILING` and keeps retrying, because the transaction may already be on chain; requeue refuses it. Metrics, `/healthz` and the `worker_heartbeat` table expose worker liveness and backlog.

Proof target/version and prepared transaction identity cannot be changed or deleted through ordinary database writes. Outbox effect fields are immutable; only delivery state can change. A changed signer/contract configuration leaves existing bound jobs for administrator reconciliation. If an externally recorded proof disappears and its original signed bytes are unavailable, the worker stops for reconciliation instead of allocating an unknown replacement nonce.

## Local and testnet setup

`npm run demo:api` creates `.local/audit-hmac-key.txt` once and runs the chainer/proof worker in the same process as embedded PostgreSQL. Preserve that file across restarts. With all Amoy settings empty it does not contact a blockchain RPC. Standalone PostgreSQL API and worker both require the same 32-byte base64url `AUDIT_HMAC_KEY` from `.env`; schema setup itself does not need this secret.

`npm run contracts:compile -w apps/api` compiles the pinned Solidity source locally, without compiler downloads, to `.local/contracts/DemoProofRegistry.json`. Deploy that artifact to Amoy with the intended writer address using trusted deployment tooling. Record the deployed address and `keccak256(eth_getCode(address))`, whose runtime value includes the immutable writer. Set all four server settings together:

```text
AMOY_RPC_URL=<HTTPS endpoint>
AMOY_CONTRACT_ADDRESS=<deployed DemoProofRegistry address>
AMOY_CONTRACT_CODE_HASH=<0x-prefixed runtime keccak256>
AMOY_SIGNER_KEY_FILE=<private server path containing testnet-only private key>
AMOY_CONFIRMATIONS=12
AMOY_MAX_FEE_GWEI=200
```

No RPC endpoint, deployed contract or funded signer was supplied during this slice, so no Amoy transaction was sent. The code uses [Polygon's Amoy network ID](https://polygon.technology/blog/introducing-the-amoy-testnet-for-polygon-pos) and [ethers v6 transaction/receipt APIs](https://docs.ethers.org/v6/single-page/). The UI links actual Amoy transaction hashes to its explorer; local EVM results are never labelled as Amoy confirmations.

## Validation

Automated integration tests cover MAC corruption before/after chaining, immutable rows, committed ordering, historical backfill, stale lease fencing, scoped audit reads, durable prepared transactions, uncertain submission retry, confirmation loss and conflict without changing issued units. A local Hardhat EVM compiles and deploys the actual contract and checks unauthorized writes, exact replay, changed effect/head rejection, receipt depth, snapshot/reorganisation recovery, and network/code/calldata restrictions. Existing rollback checks still cover the business/audit/outbox transaction.

Manual phone/PWA checks remain deferred at the user's request. Next product slice: buyer allocation and simulated purchase/payment, followed by ledger/payouts and certificates.

Final checks passed across 27 automated tests, workspace type checks and production builds, plus targeted final guard/fingerprint checks. Live smoke verified a new two-unit issuance with 11 signed case events; the chain and queued intent survived an API restart. `node scripts/demo-pwa-smoke.mjs` checked the current worker, all 27 static cache assets, served history UI and API health.
