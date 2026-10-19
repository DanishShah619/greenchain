# 10 · System Architecture — GreenChain (full application)

Status: Draft v3 (revised after two technical reviews) · Consolidates and extends [02](02-tech-stack-adrs.md), [06](06-technical-design.md), [08](08-mrv-module-design.md), [09](09-pricing-invoicing-design.md) · Decisions D1–D16 in [MANIFEST.md](../MANIFEST.md). **[A]** = assumption.

Scope: the **MVP architecture in full**, plus the **extension points** by which the deck's later layers (produce marketplace, contract farming, dual INR/FX market, ads/services) attach without re-architecture. Later layers are not designed in detail here.

Detailed feature implementation contracts live in [features/README.md](features/README.md). Their [shared baseline](features/common-contracts.md) defines dependency direction, actor/resource scope, transactional ports, replay and worker contracts. Review the [issues register](features/design-issues.md) for conflicts requiring reconciliation before affected code is built; these are draft resolutions, not evidence of runtime security or capacity.

Current implementation baseline: [15-system-design.md](15-system-design.md) expands consistency, lock ordering, durable jobs, capacity, failover and restore. Its explicit engineering corrections take precedence over earlier draft paragraphs. Financial/legal policy questions remain flagged.

---

## 1. Architectural drivers

| Driver | Source | Consequence |
|---|---|---|
| Money and credits must never be double-spent | Deck (COP, ACID), D1 | Single-writer Postgres (CP) for registry, orders, ledger |
| Field data is captured where the network is unreliable | D2, D13 | Offline-first agent PWA, AP edge, idempotent sync |
| End users are low-literacy farmers on low-end phones | D2, D9 | Assisted channel, SMS notifications, accessibility as a release gate |
| Trust and auditability are the product | PDF synopsis | Append-only ledger, hash-chained audit log, per-farmer statements |
| Small team, final-year timeline, ~500K farmers design target | D4 | Modular monolith, boring technology, documented scale path |
| Privacy law and erasure rights | D11, 06 §8 | Per-subject keys, pseudonyms, no PII in immutable stores |

## 2. System context (C4 level 1)

```
   Farmers ──SMS──────────────┐          ┌── Razorpay (collect, webhooks, refunds)
        ▲                     │          ├── Payout rail (sandbox adapter; real rail later)
        │ (in person)         ▼          ├── Penny-drop / bank verification (adapter)
   Field agents ───────► GREENCHAIN ◄────┼── SMS provider (DLT templates; IVR later)
   Institutions/verifiers ──►   │        ├── Satellite exports (Sentinel-2 / Landsat / Bhuvan via cached GEE)
   Corporate buyers ─────────►  │        ├── Land-record references (manual attestation in MVP)
   Admin / finance / auditors ─►│        ├── KMS / secrets manager
                                └───────►└── Polygon Amoy (proof minting, audit anchoring)
```

Every external system sits behind a **port/adapter**; the domain never imports a vendor SDK (see §8).

## 3. Containers (C4 level 2)

```
 ┌───────────────────────┐   ┌─────────────────────────┐
 │ Agent PWA (offline)   │   │ Web app (buyer, verifier,│   static assets from CDN / object storage
 │ IndexedDB outbox,     │   │ admin, finance) – same   │
 │ device key, i18n      │   │ Next.js static build     │
 └──────────┬────────────┘   └────────────┬────────────┘
            │ HTTPS (sync batch, resumable media)         │ HTTPS
            ▼                                              ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ API service (Node/TS, modular monolith) – stateless, N instances │
 │  HTTP edge · auth/sessions · RBAC · idempotency · rate limits    │
 └───────────────┬──────────────────────────────┬───────────────────┘
                 │ SQL (primary)                 │ enqueue (same transaction)
                 ▼                               ▼
 ┌────────────────────────────┐     ┌────────────────────────────────┐
 │ PostgreSQL 16 + PostGIS     │◄────│ Worker service (same codebase) │
 │ primary + sync standby (HA) │     │ outbox consumer · MRV · payouts│
 │ jobs/outbox tables          │     │ invoices · notify · chain · jobs│
 │ read replica (later)        │     └───────────────┬────────────────┘
 └────────────────────────────┘                     │ via adapters
 ┌────────────────────────────┐                     ▼
 │ Object storage (India)      │          Razorpay · SMS · payout rail · GEE exports · Polygon
 │ media, certificates, exports│
 └────────────────────────────┘     KMS: minter key, subject-key wrapping, signing
```

- **One codebase, two process types** (API and worker) → one deploy pipeline, shared domain code, separate scaling.
- **No Redis, no second database, no message broker** in the MVP (ADR-004, boring-by-default review).
- **Static frontends**: no server-side rendering; all business logic is behind the API.

## 4. Components inside the monolith (C4 level 3)

| Module | Responsibility | Owns tables (examples) | Stories |
|---|---|---|---|
| `identity` | OTP login, sessions, devices, RBAC, consent, KYC state, DPDP requests, subject keys | users, sessions, agent_devices, consents, subject_keys, pseudonyms, erasure_journal, payee_verifications | E1, E2 |
| `land` | plots, rights, polygons, crop cycles, duplicate/overlap checks, freezes | land_plots, plot_rights, crop_cycles | E4 |
| `capture` | sync API, outbox dedup, media upload, time-token checks, quarantine | capture_events, media | E3 |
| `mrv` | versioned methodology, NDVI selection, calculation (doc 08) | ndvi_observations, ndvi_input_sets, parameter_sets, methodology_versions, carbon_calculations, mrv_runs | E5 |
| `verification` | queue, risk ranking, decisions (writes the issuance basis), spot checks, agent scoring | verifications, issuance_basis, issuance_basis_revocations | E6 |
| `registry` | credit issuance, counters, buffer, state machine, freeze/reversal | credits, credit_counters, buffer_pool_entries, plot_carry_over, issuance_deltas | E7 |
| `frps` | event-sourced reliability score, tiers, commission schedule | frps_events, frps_scores | E8 |
| `market` | inventory, FCAE allocation, orders, reservations | orders, order_items, farmer_available, farmer_alloc_state, payee_groups, farmer tier projection (fed by events), order_item_commission (snapshot at allocation) | E9 |
| `pricing` | price lists, snapshots, tax rules and order-time tax resolution (doc 09) | price_lists, price_list_entries, order_price_snapshots, order_tax_lines, tax_rules | E9 |
| `payments` | gateway orders/attempts, webhooks, reconciliation, refunds | payment_attempts, payment_events | E10 |
| `ledger` | append-only earnings and reversal rows, receivables, reversal reserve | ledger_entries, journal_entries, journal_lines, earning_lots, lot_state_events, receivables, receivable_events, reversal_cases, ledger_config, payee_ledger_state | E10, E7 |
| `payouts` | payout port, retries, settlement states | payout_batches, payouts, payout_items, payout_attempts, recon_runs | E10 |
| `invoicing` | receipts, commission invoices, credit notes, numbering; consumes tax snapshots (doc 09) | invoices, invoice_lines, invoice_series | E10 |
| `certificates` | purchase/retirement certificates, verification URLs | certificates | E11 |
| `chain` | KMS-signed mint, audit anchoring | audit_anchors, chain_jobs | E12 |
| `notify` | SMS templates per language, receipts, agent work queue | notifications, agent_tasks | E13 |
| `audit` | unchained inserts, chainer worker, verification job | audit_log | E1 |
| `disputes` | raise, evidence, freeze orchestration, appeals | disputes, dispute_evidence, appeals | E7 |
| `kernel` | outbox/jobs, idempotency keys, configuration, clock; no business logic (everyone depends on it) | outbox, jobs, idempotency_keys, config | E1 |
| `admin` | invariants and reconciliation dashboards (read ports only), configuration screens | – | E15 |

### Dependency rules (enforced by lint/import boundaries)
```
kernel ◄── (all)                        identity ◄── (all)         audit ◄── (all: append only, via function)
land ◄── capture, mrv, verification, registry, disputes
capture ──► land                         mrv ──► land, capture (read ports; never verification)
verification ──► mrv, land, capture      registry ──► verification (issuance_basis), mrv (calculation)
market ──► registry, pricing             pricing ──► nothing (allocation passed by value; owns tax_rules)
payments ──► market                      ledger ◄── payments, registry (ports/events); ledger receives immutable fulfilment/commission snapshots by value from the application workflow; no ledger → market orchestration edge
payouts ──► ledger                       disputes ──► land, registry, market (freeze/void via ports)
invoicing ──► ledger, market (OrderRead), payments (PaymentRead)     certificates ──► market, ledger (read ports)
frps, chain, notify ◄── domain events only (no inbound sync calls)
market's FRPS tier = local projection of `FrpsTierChanged{group, tier, commission_bps, seq}` events: stale or duplicate events are ignored by a per-group sequence number, the projection is bootstrapped from an `frps` snapshot read through a port at start-up, and the tier, `commission_bps` and `seq` used are written to the allocation log and the order's `order_item_commission` snapshot (so allocation stays deterministic and replayable)
market also reads the priced-key set from `pricing` before allocating (market ──► pricing)
```
- **Downward calls are synchronous through interfaces** (ports) inside the same transaction when atomicity is required (e.g., `market` reserves credits via `registry`).
- **Upward notification is by domain events** written to the outbox in the same transaction; consumers are idempotent.
- **No module reads another module's tables.** A cross-module query goes through the owner's read port. DB roles follow the same rule: a worker role such as `mrv_worker` is granted SELECT on **views exposed by the owning module** (e.g. `land.v_plot_for_mrv`), never on base tables.
- **No cycles.** Parameters that two modules need are passed by value (e.g. the allocation into `pricing`); data flowing upward (tier, credit issued, payment received) travels as events.
- **Erasure and lookups:** `identity ◄── (all)` is a read-only lookup edge. Erasure fans out by `SubjectErasureRequested` events to the owners of PII-bearing tables; `identity` never calls other modules, which keeps the edge acyclic.

## 5. Key runtime flows

### 5.1 Capture and sync (AP edge)
```
Agent app (offline) ─ outbox event {id, device sig, captured_at, time_token_id, segment, mono_ms}
   └─ online ─► POST /sync/batch ─► capture: dedup (device,id) → validate → time-token check
                  ├─ ACCEPTED / DUPLICATE / REJECTED / DEFERRED / CONFLICT / QUARANTINED
                  └─ writes capture_event + audit row + outbox event(PlotCaptured…) in ONE transaction
   └─ media: resumable chunks ─► object storage ─► media_complete gate
```

### 5.2 Evidence → credit
```
cycle end + media_complete / material NDVI change ─► mrv job ─► carbon_calculation (immutable, inputs_hash)
   ─► verification queue (risk-ranked) ─► Verifier decision VERIFIED writes issuance_basis (the reviewed calculation)
   ─► registry issuance job: whole credits from that basis, carry-over, buffer pool
   ─► CreditIssued ─► frps events, notify (SMS), display inventory projections (authoritative farmer_available updates synchronously during issuance)
```

### 5.3 Order → money → proof
```
Buyer ─► POST /orders (idempotency key)
   tx: lock(credit_type) → FCAE allocate → reserve credits → price snapshot → audit → commit
Buyer ─► create payment attempt ─► Razorpay (hold extends only once the gateway confirms PENDING)
Razorpay webhook ─► verify raw-body HMAC ─► payment_events UNIQUE ─► ownership check ─► order PAID → FULFILLED (one tx):
      credits SOLD · ledger rows (tier-snapshot commission) · alloc_state updated · outbox events
   ─► workers: invoices, payouts (port), certificates, chain mint, SMS
Late success on a lapsed/cancelled order, or ownership mismatch ─► REVALIDATING ─► PAID or REFUND_PENDING → REFUNDED
```

### 5.4 Dispute and reversal
```
Dispute raised ─► plot/credits FROZEN ─► institution resolves
   confirmed ─► credit REVERSED (or reversed_after_retire) ─► REPLACEMENT credit from buffer (whole tonnes)
   ─► ledger reversal rows · reversal reserve / receivable · credit note · buyer + farmer notified
```

## 6. Deployment architecture

| Aspect | MVP design |
|---|---|
| Region | Single Indian region, two availability zones |
| Compute | API: ≥ 2 stateless container instances behind a load balancer; worker: 1–2 instances (scale by queue depth) |
| Database | Managed PostgreSQL 16 + PostGIS; synchronous standby in the second AZ; PITR backups; monthly restore test |
| Storage | S3-compatible bucket(s) in-region; pre-signed URLs ≤ 1 h; lifecycle rules per retention class |
| Edge | CDN for static frontends; WAF + rate limiting at the edge; TLS everywhere |
| Secrets/keys | Secrets manager; KMS for minter, subject-key wrapping and signing keys; separate per environment |
| Environments | dev (Docker Compose: Postgres+PostGIS, mock gateways) → staging (synthetic data) → prod/demo |
| CI/CD | Trunk-based; build → unit/integration/property tests → migrations dry-run → deploy; forward-only expand/contract migrations; feature flags; rollback runbook |
| Observability | OpenTelemetry traces, structured JSON logs, Prometheus-style metrics, error tracking; business-invariant dashboards (06 §11) |
| IaC | Terraform (or equivalent) for network, DB, storage, KMS, roles |

**Sizing sketch [A]:** API 2 × (1 vCPU, 1–2 GB); worker 1 × (2 vCPU, 2 GB); Postgres 4 vCPU / 16 GB / 200 GB SSD to start; object storage grows ~450 GB/yr at 500K farmers (06 §12). Worker and API have **separate capacity limits**: the `mrv` queue has its own concurrency cap so MRV bursts cannot starve invoicing and payouts; the audit chainer runs as one active instance under a **lease row with a fencing token** (a session advisory lock does not survive PgBouncer transaction pooling; correctness rests on a UNIQUE `chain_seq`) and is sized for peak sync rate, not the average.

## 7. Cross-cutting architecture

| Concern | Approach | Where specified |
|---|---|---|
| Consistency | CP for credits/orders/payments/ledger; AP at the edge; stale reads labelled | 06 §2 |
| Idempotency | Keys on every mutating endpoint, UNIQUE constraints as the store, webhooks via `payment_events` | 06 §4.2, §5 |
| Transactions & events | Business change + audit row + outbox event in one DB transaction | 06 §4, ADR-004 |
| Authentication/authorization | Server-side sessions, device-bound, RBAC and tenant checks server-side per request | ADR-006, 06 §8 |
| Privacy | Per-subject keys, random pseudonyms, no PII in audit/ledger/chain | 06 §8 |
| Auditability | Unchained audit inserts + single chainer; periodic anchoring | 06 §11 |
| Resilience | Retries with backoff and jitter; dead-letter; reconciliation jobs; lazy reservation expiry | 06 §4–5 |
| Network unreliability | Outbox, resumable media, small batches, explicit result codes, time-token integrity | 06 §5 |
| Accessibility | WCAG 2.2 AA, en/hi/bn, icon-first, voice prompts, SMS | ADR-010 |
| Configuration | Versioned, two-person-published parameter sets, price lists, tax rules; no behaviour hidden in env vars | 08, 09 |
| Observability | Business invariants as first-class alerts | 06 §11 |

## 8. Ports and adapters (vendor isolation)

| Port | MVP adapter | Replaceable by |
|---|---|---|
| `PaymentGateway` | Razorpay (sandbox → live) | PayU / Cashfree |
| `PayoutPort` | Sandbox bank simulator | RazorpayX / bank API |
| `KycPort` (penny-drop) | Sandbox adapter | Licensed provider |
| `SmsPort` | SMS provider w/ DLT templates | IVR/voice provider |
| `SatellitePort` | Cached GEE export reader | Live GEE / other provider |
| `ChainPort` | Polygon Amoy via KMS signer | Mainnet / other timestamping |
| `ObjectStore` | S3-compatible | any compatible store |
| `LandRecordPort` | Manual attestation | State land-record API |

## 9. Quality attribute scenarios

| Attribute | Scenario | Tactic | Measure |
|---|---|---|---|
| Consistency | Two buyers order the last credits simultaneously | Per-type advisory lock + partial UNIQUE | 0 double allocations in race test |
| Availability (edge) | Agent has no signal for 3 days | Local outbox, signed events, time token | 100% eventually ACCEPTED or explicit REJECTED |
| Availability (core) | Primary DB fails | Sync standby failover; clients retry with idempotency keys | RPO 0, RTO ≤ 15 min **[A]** |
| Durability | Worker crashes mid-invoice | Row-locked numbering, UNIQUE keys, retries | One invoice set, no gaps |
| Security | Forged webhook | HMAC on raw body, secret rotation | Rejected + alerted |
| Privacy | Farmer requests erasure | Destroy subject key + mapping | PII unreadable; audit intact |
| Performance | Order for 10k eligible groups | Maintained `farmer_available` aggregate | p95 < 200 ms DB time **[A]** |
| Scalability | 10× farmers | Read replica → PgBouncer → partitioning → shard lock → split modules | Triggers in 06 §12 |
| Modifiability | Add a produce marketplace | New module behind existing ports and events | No change to the audit chain or ledger immutability; any registry state-machine addition is an explicit architecture change (§10) |
| Usability | Low-literacy farmer misunderstands consent | Spoken consent, teach-back, SMS summary | Usability test pass rate |

## 10. Extension points for later layers

| Later layer (deck) | Attaches as | Reuses | New pieces |
|---|---|---|---|
| LTCC / TPC credits | New credit kinds with their own transition tables in `registry`; methodology modules in `mrv` | Allocation, pricing, ledger, invoices | Multi-year vault rules, **advance-payment (pre-issuance) sales, which extend the registry state machine and need an architecture review**, tree-count evidence |
| Produce marketplace, EcoTrust, donations | New modules `produce`, `nudge`, `donations` | identity, frps events, ledger, payouts, notify | Listings, orders for goods; **a `Payable` abstraction (`item_type`, `item_id`) so `payments`, `ledger` and invoice lines stop assuming a credit**, logistics hooks |
| Contract farming | Module `contracts` | land, frps, payments, capture (reports) | Contract state machine, milestone escrow, arbitration, **a double-entry account/balance model (`ledger_accounts`) that the earnings ledger does not have today** |
| Dual INR/FX market | `PaymentGateway` + `FxPort` adapters; multi-currency in pricing/ledger | price lists per currency, ledger | `currency` columns (recommended now, default `INR`) on prices, orders, ledger and invoices; FX conversion, INR guarantee policy, compliance |
| Agri ads/services | Module `services` | identity, notify | Listing and billing |
| Real payout rail, mainnet | Adapter swap | Ports | Legal/KYC onboarding |

Rule: a new layer must not require changes to **ledger immutability or the audit chain**. Additions to the registry state machine (vault rules, pre-issuance sales) and to money models (accounts, currency, non-credit payables) are allowed only as explicit, reviewed architecture changes with their own ADR; they are listed above rather than claimed as free.

## 11. Architecture risks and trade-offs

| Risk / trade-off | Mitigation | Revisit trigger |
|---|---|---|
| Single primary is a write bottleneck and single region is an availability ceiling | Short transactions, partitioning, sync standby; documented scale path | Sustained primary CPU > 60% or SLO > 99.9% required |
| Home-grown offline sync | Narrow append-only event model; SP-1 evaluates off-the-shelf libraries first; chaos tests | PWA storage eviction proves unworkable ⇒ native wrapper |
| PWA on low-end devices | Memory/size budgets, device-lab tests | Task failure rate above target |
| Monolith coupling over time | Import-boundary lint, per-module table ownership, events upward | Module needs independent scaling or team ownership |
| Per-subject encryption adds key-management complexity | Narrow to PII columns; KMS-wrapped data keys | Key-management incidents or performance issues |
| Blockchain proof adds dependency and cost | Async, behind a port, never on the critical path | Mainnet or durability requirement |
| Tax and legal rules unknown | Tax-agnostic structure, versioned rule table | Accountant/legal answers (T-1…T-9) |
| Scientific credibility of MRV | Versioned methodology, conservative factors, buffer, honest NDVI framing (doc 08) | Registry methodology adoption |

## 12. Decision register

Existing: ADR-001…ADR-010 in [02-tech-stack-adrs.md](02-tech-stack-adrs.md). Added by this architecture:

**ADR-011 · Module boundaries: downward ports, upward events**
- **Context:** a modular monolith decays when modules call each other freely.
- **Options:** (a) free calls; (b) ports downward + outbox events upward (chosen); (c) split into services now.
- **Decision:** (b), enforced by import-boundary lint and per-module table ownership (§4).
- **Trade-offs:** more indirection and eventual consistency for notifications; keeps atomicity where needed and the split path open.
- **Revisit when:** a module requires independent deployment.

**ADR-012 · Two process types from one codebase**
- **Decision:** an API process and a worker process built from one repo and image, differing by entrypoint; both stateless; workers scale on queue depth.
- **Trade-offs:** shared code and one pipeline vs coupled release; acceptable at team size.
- **Revisit when:** worker dependencies or scaling profile diverge strongly from the API.

**ADR-013 · Additive double-entry journal beside the earnings ledger**
- **Context:** reversals, a reversal reserve and receivables are accounting concepts the earnings-only ledger cannot express safely (doc 11).
- **Options:** (a) extend `ledger_entries` with more columns; (b) a double-entry `journal` beside it, written in the same transaction (chosen); (c) replace the earnings ledger.
- **Decision:** (b). The earnings rows remain the feed for invoicing and statements; the journal is the accounting record; a reconciliation job asserts they agree.
- **Trade-offs:** two write paths inside one transaction and a reconciliation job; far safer than overloading earnings rows; extends cleanly to escrow accounts for contract farming later.
- **Revisit when:** a second currency or non-credit payables arrive (the `Payable` abstraction in §10).

## 13. What this document does not settle
Open items are tracked in the manifest: factor sources and tax rules (Q-OQ-18…20), team capacity (Q-OQ-10), legal path for payouts/KYC (SP-3), SMS/DLT vendor (Q-OQ-8), and the unconfirmed ADRs (004, 006). The reversal-reserve and payout/KYC designs are now docs [11](11-reversal-reserve-design.md) and [12](12-payouts-kyc-design.md). The technical-review findings applied in this revision are recorded in the manifest change log (rev 7).
