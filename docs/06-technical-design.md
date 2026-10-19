# 06 · Technical Design

Status: Draft v3 (technical-review rounds 1-3 applied) · Implements decisions D1–D16 in [MANIFEST.md](../MANIFEST.md). Numbers marked **[A]** are assumptions to validate.

Implementation review notice: [feature specifications](features/README.md) now expand this design. The [issues register](features/design-issues.md) identifies unresolved inconsistencies in fulfilment locks, audit sequence gaps, issuance-basis replacement, freeze representation and partitioned references. Its proposed contracts guide the new drafts; reconcile the affected schema and paragraphs before implementation. In particular, sequence gaps alone are not evidence of deleted audit rows.

---

## 1. Architecture

```
 Field agent PWA (offline, IndexedDB outbox)      Corporate web      Verifier web      Admin web
            │  HTTPS, batch sync, idempotent          │                  │                │
            └──────────────────────┬───────────────────┴──────────────────┴────────────────┘
                                   ▼
                     API / Backend (single Node+TS deployable, modular monolith)
        ┌───────────┬─────────────┬────────────┬────────────┬────────────┬───────────┐
        │ identity  │ land        │ capture/   │ mrv        │ registry   │ market    │
        │ & consent │ & rights    │ sync       │ (versioned │ (credits,  │ (orders,  │
        │           │             │            │ methodology│ buffer)    │ FCAE)     │
        ├───────────┼─────────────┼────────────┼────────────┼────────────┼───────────┤
        │ payments  │ ledger &    │ frps       │ notify     │ audit &    │ admin     │
        │ (in)      │ payouts(out)│            │ (SMS/IVR)  │ anchoring  │           │
        └───────────┴─────────────┴────────────┴────────────┴────────────┴───────────┘
                                   │                                  
        PostgreSQL 16 primary (source of truth, incl. outbox/job tables)  ──► read replica (reports, dashboards)
                                   │
        Worker process (same codebase): outbox relay · MRV · certificates · payouts · mint · notifications
                                   │
        Object storage (India region): photos, certificates, reports    KMS: minter key, signing keys
        Adapters: Razorpay (collect) · Payout port (sandbox) · SMS/IVR · GEE exports · Polygon Amoy
```

Rules: modules talk through in-process interfaces and domain events; no module reads another module's tables directly (enforced by schema ownership + lint rule). Anything that can later become a service communicates through the outbox.

## 2. Consistency model (CAP/PACELC) per data class

| Data class | Choice | Why | Behaviour during partition / outage |
|---|---|---|---|
| Credits, orders, payments, ledger, FCAE state | **CP** | Double-sale/double-payout is unacceptable | Writes only against the Postgres primary. If unreachable the API returns 503 + `Retry-After`; client never fabricates state. |
| Field captures (plots drafts, proofs, onboarding forms) | **AP** at the edge | Network is unreliable where data is collected | Device accepts and queues. Server dedups by `(device_id, client_event_id)`. Eventually consistent, conflicts resolved by rules in §5. |
| Derived views (FRPS display, inventory counts, dashboards) | Eventual, labelled | Reads may be stale | UI shows "last synced <time>"; money/credit-changing actions always re-validate on the server. |
| Audit log | CP, append-only | Tamper evidence | Written in the same transaction as the change. |
| Blockchain proof | Eventual | Not on the critical path | Minting retried; sale/payout never wait for chain. |

PACELC (else-branch): prefer **consistency over latency** for registry/market (single primary, synchronous commit); accept replica lag only for reports (target < 5 s **[A]**).
Failover: managed Postgres HA with synchronous standby in a second AZ; RPO 0 for committed money transactions, RTO ≤ 15 min **[A]**. Multi-region active-active is explicitly out of scope (ADR-001).

## 3. Data model (core tables)

All money as integer paise; all CO₂e as `NUMERIC(12,4)` tonnes; all PKs UUIDv7 unless noted; every table has `created_at`.

| Table | Key columns / constraints |
|---|---|
| `users` | id, role (`FARMER`,`AGENT`,`BUYER`,`VERIFIER`,`ADMIN`), phone (encrypted + blind index), status |
| `institutions`, `agents` | agent → institution; `agent_devices(device_id, public_key, revoked_at)` |
| `farmer_profiles` | user_id, language, payee_user_id nullable, `kyc_status`, `payout_account_ref` (tokenised), consent version FK |
| `consents` | subject, purpose, text_version, language, evidence (signature/photo/voice ref), captured_by_agent, otp_verified_at nullable, revoked_at |
| `land_plots` | id, `state_code`, **`plot_code`** (short, human-readable, UNIQUE per state, e.g. `PLT239`, used in credit IDs), `land_record_ref`, polygon (PostGIS), `plot_hash` UNIQUE, area_ha, status (incl. `WITHDRAWN`), `frozen` bool |
| `plot_rights` | plot, holder, type (`OWNER`,`CULTIVATOR_WITH_CONSENT`), consent_doc_ref, verified_by, `nominated_payee_id` — **the only payee source for a plot's earnings**; `farmer_profiles.payee_user_id` is only the default offered when nominating |
| `capture_events` | (device_id, client_event_id) UNIQUE, `payload_hmac` (HMAC under the subject's EVIDENCE key, or over the ciphertext, so it is destroyed with the key and is not linkable after erasure; used only to compare duplicate keys), agent, type, payload (PII-bearing fields stored encrypted under the subject key), captured_at_device, received_at, `time_token_id`, skew_ms, `seq_in_aggregate`, `session_segment`, `time_trust` (`VERIFIED_IN_SEGMENT`,`UNVERIFIABLE`,`FLAGGED`), status (`ACCEPTED`,`DEFERRED`,`REJECTED`,`QUARANTINED`,`FLAGGED`), rejection_reason |
| `subject_keys` | subject_id, `key_class` (`CONTACT`,`IDENTITY`,`EVIDENCE`,`FINANCIAL_REF`), `generation`, wrapped data key (KMS), created_at, `destroyed_at` — per-subject, **per-class** envelope keys so e.g. contact data can be shredded while a statutory financial reference is retained (§8) |
| `erasure_journal` | random `erasure_id`, `pseudonym_id`, key_class, `key_generation`, erased_at — append-only and **kept outside the database backup chain** (separate store, own retention); contains no real identifiers; replaying it (destroying exactly the listed key generations) is a mandatory step of every restore (§8) |
| `pseudonyms` | subject_id ↔ random `pseudo_id` (not derived from PII); mapping row deletable on erasure |
| `plot_carry_over` | plot, `credit_type`, vintage_year, tonnes_remainder; remainders accumulate across cycles and vintages until ≥ 1 whole credit |
| `payment_attempts` | id, order, provider_order_id, state (`CREATED`,`PENDING`,`SUCCEEDED`,`FAILED`,`CANCELLED`), amount_paise, started_at; multiple attempts per order allowed |
| `media` | capture_event, s3_key, sha256, exif_gps, exif_time, size, status |
| `crop_cycles` | plot, crop, season, start, end |
| `ndvi_observations` | plot, date, source, ndvi, cloud_pct (plain partitioned table; Timescale deferred, ADR-005) |
| `carbon_calculations` | cycle, methodology, mrv_version, inputs jsonb, gross_co2e, confidence, buffer_pct, `supersedes` FK, immutable (no flag is ever flipped; see doc [08](08-mrv-module-design.md)) |
| `issuance_basis` | `basis_id` PK, cycle_id, calc_id, verification_id, selected_by, at — immutable history owned by verification; one active unrevoked basis is selected by `cycle_verification_state(cycle_id PK, active_basis_id, generation)` under the cycle lock; registry records the exact basis/generation |
| `issuance_basis_revocations` | basis id, reason (appeal, spot-check failure, dispute), revoked_by, at — append-only; registry re-checks it under its lock before issuing |
| `issuance_deltas` | `delta_id` (idempotency key), cycle_id, basis id, calc_id, approved_by, status — admin-approved changes after a basis exists; issuance of a delta is idempotent on `delta_id`, not `calc_id` |
| `payee_groups` | id, verified payee account token, members; the allocation group function `payee_group_of(plot_rights.nominated_payee)` |
| `verifications` | plot/calc, verifier, decision (`VERIFIED`,`DISPUTED`,`NEEDS_VISIT`), notes, evidence_snapshot_hash, decided_at |
| `credits` | id `GC-IN-{STATE}-{plot_code}-{YEAR}-{TYPE}-{SEQ}` (VARCHAR(48)) UNIQUE, `kind` (`ISSUED`,`REPLACEMENT`), calc FK NOT NULL, tonnes (whole), status, `reserved_order_id`, `reserved_until`, `frozen`, `reversed_after_retire` bool, `replaces_credit_id` nullable FK, `available_since` (set at issuance, preserved across release and reaping), active case hold references (`frozen` is a derived condition; no obsolete restore target), `sold_payee_group_id` (snapshot at sale), `chain_tx_hash`; partitioned by vintage_year, so every UNIQUE and FK on `credits` (`credit_id`, `replaces_credit_id`) includes `vintage_year`; index on `(reserved_until) WHERE status='RESERVED'` for reaping |
| `farmer_available` | `payee_group_id`, `credit_type`, `state_code`, `vintage_year` (the dimensions buyers filter on), `available_count`, `reserved_count`, `oldest_available_at` — maintained aggregate, updated in the same transaction as credit state changes **under the type lock**; allocation sums matching rows per group, so filtered orders never over-count; `oldest_available_at` = min `credits.available_since` of AVAILABLE rows and is **preserved on release/reap** (never reset to now) |
| `credit_counters` | (plot, year, type) → next_seq (row lock gives collision-free SEQ) |
| `buffer_pool_entries` | credit/calc, tonnes, status (`HELD`,`CONSUMED`) |
| `orders` | id, buyer, **single `credit_type`**, qty, filters, state, expires_at, shortfall, `cap_override` (audited, default off); price lives in `order_price_snapshots` and per-item `unit_price_paise` (see [09](09-pricing-invoicing-design.md)); payment attempts are in `payment_attempts` |
| `price_lists`, `price_list_entries`, `order_price_snapshots`, `invoice_series`, `invoices`, `invoice_lines`, `tax_rules` | specified in [09-pricing-invoicing-design.md](09-pricing-invoicing-design.md) §3; invoices are generated when an order reaches `FULFILLED` (§7 there) |
| `order_items` | order, credit_id, `active` bool (denormalised; partial UNIQUE on `(credit_id) WHERE active`) |
| `payment_events` | `provider_event_id` UNIQUE, order, type, payload, processed_at (webhook idempotency) |
| `ledger_entries` | append-only; account, order, credit, gross, commission_pct, net, direction, `reverses` FK; payee group, `releasable_at` and the tier snapshot are set at FULFILLED; settlement/lot state is **derived** from `lot_state_events` (no mutable `settlement_state`); the double-entry `journal_entries`/`journal_lines`, `earning_lots`, `receivables`, `reversal_cases` and `ledger_config` (ADR-013) are specified in [11](11-reversal-reserve-design.md) and written in the same transaction |
| `payouts` | see [12](12-payouts-kyc-design.md) §3: `payout_batches`, `payouts` (UNIQUE batch+payee; idempotency key = id), `payout_items`, `payout_attempts`, `recon_runs`; `payee_verifications` live in `identity` |
| `frps_events` | farmer, rule, delta, evidence ref; score derived (materialised in `frps_scores`) |
| `farmer_alloc_state` | `payee_group_id`, `last_allocated_at` (set only when an order is FULFILLED), `alloc_count_30d` (FCAE input, Postgres-owned) |
| `audit_log` | `id` (insertion order, **not** commit order), `insert_seq` (database sequence value) and `insert_mac` (keyed MAC over entity, action, payload_hash and `insert_seq`) — both assigned **at insert time** by the single audit-write function, so deleting an unchained row leaves a gap the chainer can detect; entity, action, actor (pseudonymous ID), payload_hash (**never hashes raw PII**), then `chain_seq`, `prev_hash`, `hash` filled by the chainer only (column-level UPDATE grant; §11); REVOKE DELETE and all other UPDATE |
| `audit_anchors` | head_hash, head_seq, chain_tx_hash, anchored_at |
| `outbox` / jobs | transactional enqueue (pg-boss tables or equivalent), `SKIP LOCKED` consumers |

COP chain by FK: `land_plots → crop_cycles → carbon_calculations → credits → order_items`. Orphan credits are impossible (NOT NULL FKs, no deletes).

**Payee re-key:** when a plot's nominated payee changes, one transaction takes the type locks for every credit type of the affected credits (sorted), moves `available_count`/`reserved_count` rows between groups, writes a `PayeeRekeyed` audit event and updates `farmer_alloc_state` ownership; credits already SOLD keep their `sold_payee_group_id` snapshot. The recount invariant uses the same group function.

## 4. State machines

### 4.1 Credit
```
 (calc VERIFIED) ──issue──► AVAILABLE ──reserve──► RESERVED ──pay ok──► SOLD ──retire──► RETIRED (terminal)
                                ▲                      │ release (expiry / cancel / refund / void)
                                └──────────────────────┘
 AVAILABLE | RESERVED | SOLD ──dispute/fraud──► FROZEN ──resolved──► previous state
                                                  │ confirmed
                                                  ▼
                                              REVERSED (terminal; counts against the buffer pool)
 RETIRED + later fraud finding ──► row stays RETIRED, `reversed_after_retire = true`,
                                   a REPLACEMENT credit (kind=REPLACEMENT, replaces_credit_id) is issued to the buyer from the buffer pool
```
- Transitions happen only inside a transaction holding a row lock; illegal transitions are blocked by a CHECK/trigger table of allowed pairs. RETIRED and REVERSED are terminal; FROZEN is never applied to RETIRED rows (the flag and replacement path is used instead).
- **FROZEN resolution:** economic `status` remains authoritative and active case holds determine `frozen`. Resolving one case removes only its hold; it never restores a voided reservation or clears another case. RETIRED remains terminal with adverse findings/remedy history.
- **REPLACEMENT credits** are created directly in state SOLD (replacing a credit reversed before retirement) or RETIRED (after retirement) from whole tonnes of the buffer pool. They are excluded from `farmer_available`, create no farmer payout, and `replaces_credit_id` is UNIQUE so a credit is replaced at most once.
- **Buffer in whole units:** `buffer_pool_entries` accrue fractional tonnes per `(credit_type, vintage)` pool. Only **whole tonnes** convert into REPLACEMENT credits; each replacement row carries the original calculation FK for provenance, so the COP chain stays unbroken.
- **Who bears the INR loss:** a reversed credit has already paid the farmer. Policy (assumption, Q-OQ-5): (a) farmer not at fault → the platform absorbs it from a *reversal reserve* funded by a configurable share of commission revenue; (b) institution-confirmed fraud → recovered only from that payee's future earnings (tracked as a receivable in the ledger; payouts never go negative). Buffer protects the *buyer's tonnes*; the reversal reserve protects the *platform's rupees*.

### 4.2 Order and payment attempt
Order and payment attempts are separate machines.

```
 Order:   CREATED ─allocate─► RESERVED ─attempt created─► AWAITING_PAYMENT ─attempt SUCCEEDED─► PAID ─► FULFILLED
             │ shortfall, buyer declines   │ cancel / reservation lapses        (credits SOLD, ledger rows, jobs enqueued, same txn)
             ▼                             ▼
         CANCELLED                      EXPIRED ─┐
             └──────────────────────────────────┴─(attempt SUCCEEDED arrives, or ownership check fails)─► REVALIDATING ─► PAID | REFUND_PENDING ─► REFUNDED
 Attempt: CREATED ─► PENDING ─► SUCCEEDED | FAILED | CANCELLED     (several attempts per order are allowed)
```
- **Order scope:** one order covers exactly one `credit_type`; a buyer who wants several types places several orders (keeps the lock model simple).
- **Reservation timing:** `reserved_until = allocation_time + 5 min`. Only when the gateway **confirms the attempt is PENDING** (not merely when an attempt row is created) is `reserved_until` extended to `max(current, confirmation_time + 15 min)`, capped at **30 min** after allocation **[A]**. After a FAILED attempt the buyer may retry within the remaining reservation.
- **Reservation quotas (anti-hoarding) [A]:** per payee group, `reserved_count` may not exceed `max(1, ⌊0.5·(available_count + reserved_count)⌋)`, so a group with one or two credits can still sell one; per buyer at most 3 open reserved orders and at most 10% of eligible supply reserved at once, counted in a per-buyer limits row that is locked first (lock order below). A quota-limited allocation returns a distinct shortfall reason (`QUOTA`, separate from `CAP` and `SUPPLY`). Re-validation of an already-paid order is **exempt** from quotas, and `cap_override` never lifts a quota.
- **Lazy expiry and takeover:** the allocator reaps lapsed reservations of the order's type under the type lock (index on `reserved_until`): the credit returns to AVAILABLE, the previous `order_items.active` is set false, aggregates are corrected. The sweeper runs the **same reap routine under the type lock** for every type with open reservations, so quiet types are reaped too and the lapsed-reservation invariant cannot fire falsely. The "no reservation past `reserved_until`" invariant check counts only rows lapsed for longer than one sweep interval.
- **Ownership check on every payment transition:** moving an order to PAID/FULFILLED locks its credits and verifies `reserved_order_id = this order` and `order_items.active`. Any mismatch routes the order to REVALIDATING (credits free again) or REFUND_PENDING — regardless of the order's visible state, so a stale `AWAITING_PAYMENT` can never mark another order's credits SOLD. Creating or confirming an attempt performs the same check before extending a hold. A webhook first reads the order's `credit_type` without locks, takes the type lock, then re-reads and re-verifies under the lock; every success handler therefore takes the type lock first.
- **Late success** (attempt SUCCEEDED for an order that is EXPIRED/CANCELLED, or whose ownership check fails): order → REVALIDATING; re-reserve the **same credits, all-or-nothing**. If all are still free → PAID. Otherwise → REFUND_PENDING (full refund; no after-the-fact partial fill) → REFUNDED. Success events are always processed through this rule; "terminal states ignore regressions" applies to non-success events only.
- **Duplicate success:** a second SUCCEEDED attempt for an order already PAID/FULFILLED never changes the order. It is recorded and a refund is queued as a `payment_refunds` row of kind `DUPLICATE` (a separate record, so the order state `REFUND_PENDING` keeps one meaning). If the order is already REFUND_PENDING/REFUNDED, an additional success is recorded the same way.
- **Sweeper:** before expiring an `AWAITING_PAYMENT` order it asks the provider whether a PENDING attempt exists.
- **Webhooks:** verify HMAC on the **raw** body; insert into `payment_events` (UNIQUE `provider_event_id`) and apply the state change in **one transaction**; replays are no-ops; whether Razorpay's event identifier arrives in a header or the payload is confirmed against its documentation in S10.1.
- **One total lock order for every transaction** (webhook, sweeper, allocation, freeze/re-allocation): (0) the per-buyer limits row (order creation only); (1) advisory lock(s) by `credit_type`, sorted — taken by allocation, reaping, issuance, freeze/re-allocation and every payment-success handler; (2) the order row; (3) credit rows in ascending `credit_id` (`FOR UPDATE SKIP LOCKED` when taking over lapsed reservations); (4) aggregate rows (`farmer_available`, `farmer_alloc_state`) in ascending group id; (5) `payee_ledger_state` rows in ascending group id (ledger postings, recovery, payout batching); (6) the reserve advisory lock `pg_advisory_xact_lock(class_reserve, 0)`. Standalone ledger/payout handlers never acquire earlier market locks. FULFILLED takes the required payee/reserve locks and commits earnings, lots, journal and reserve funding with SOLD/ownership changes. Cycle locks, where required, follow type locks and precede order locks; see doc 15 for the complete protocol. A handler that may need the advisory lock (re-validation, re-allocation) acquires it first, never after the order row.
- **Credit frozen while an order is in flight:** before payment starts, void/reallocate under ordered locks and require acceptance of the new allocation/price snapshot. Once payment is unresolved, preserve the funded credit set and follow exact-credit all-or-nothing revalidation or full refund. Normal PAID/FULFILLED commits atomically; post-fulfilment freezes enter the dispute/remedy workflow (doc 15).

### 4.3 Payout
States `PENDING → IN_SETTLEMENT → SENT → SETTLED`, plus `INDETERMINATE` (unknown outcome; resolved by querying the rail by idempotency key), `FAILED → RETRY (backoff, max N) → NEEDS_REVIEW`, `RETURNED` and `CANCELLED` (full table in [12](12-payouts-kyc-design.md) §5). Corrections are reversal ledger rows, never updates; a cancelled or returned payout reverses its recovery row and returns its lots to RELEASABLE in the same transaction.

## 5. Offline sync protocol (the AP edge)

- The agent PWA writes every action to an **IndexedDB outbox** as `{client_event_id (UUIDv7), device_id, agent_id, type, payload, captured_at_device, time_token_id, session_segment, mono_ms_in_segment, seq_in_aggregate, base_version?}`; each event (including `time_token_id` and segment fields) is signed with the device key, and the agent session is bound to a registered device.
- `POST /sync/batch` (≤ 50 events or 256 KB). Per-event result codes and client behaviour:

| Result | Meaning | Client action |
|---|---|---|
| `ACCEPTED` | stored (possibly also `FLAGGED` for review) | remove from outbox |
| `DUPLICATE` | same key **and same `payload_hmac`** already stored and ACCEPTED/FLAGGED (never returned for a `DEFERRED` row) | remove |
| `REJECTED(reason)` | permanent (validation failure, `KEY_REUSE` = same key different payload, forbidden type) | move to a visible **"needs fix"** list; never auto-retried (no poison loops); agent edits (new event ID) or discards with a reason |
| `DEFERRED` | predecessor in `seq_in_aggregate` has not arrived | keep and retry; the server holds deferred events up to 30 days **[A]**, then returns terminal `REJECTED(PREDECESSOR_MISSING)`; a verifier/admin may *declare a gap* to release successors, and a REJECTED/discarded predecessor surfaces its dependents in "needs fix" immediately |
| `CONFLICT(server_version)` | draft edit based on an outdated `base_version` | show a merge screen; no silent overwrite |
| `QUARANTINED` | event arrived from a revoked device (classified first, before any other check) | remove from outbox; the institution admin and a verifier decide (below) |

  At-least-once delivery plus dedup gives effectively-once processing. **Dedup keys live as long as the stored event** (the UNIQUE constraint on `capture_events` is the store), so a device that was offline for weeks cannot replay a key after expiry.
  **Classification order and re-sends:** (1) device revoked ⇒ `QUARANTINED`; (2) key reuse with a different payload ⇒ `REJECTED(KEY_REUSE)`; (3) predecessor missing ⇒ `DEFERRED`; (4) otherwise validate. A quarantined event counts as a predecessor for later events *of its own device* (so successors stay `DEFERRED` rather than failing), and the 30-day deferral timer is **suspended while an event is quarantined**. A re-send of a key already stored as `REJECTED` or `QUARANTINED` with the same `payload_hmac` returns the **stored status**, not `DUPLICATE`.
- **Media:** metadata first, **media after** (resumable chunked upload, client compression to ≤ 300 KB **[A]**, per-chunk retry, SHA-256 verified). Each capture event declares required **evidence slots**; a slot is `PENDING → COMPLETE | SUPERSEDED | WAIVED_BY_VERIFIER | FAILED`, with hash-mismatch retries capped (default 5 **[A]**). `media_complete` is computed over **required slots only**. A verifier may waive or supersede a slot, but as a **separate verifier action that happens before MRV and before the verification decision** (it re-evaluates `media_complete`, then triggers the MRV recompute); it is not recorded inside the decision, because MRV and the decision are gated on `media_complete`. Overdue slots create an agent task.
- **Retry:** exponential backoff with full jitter (1 s → 15 min cap); triggered by connectivity events, app open, and manual "Sync now"; honours battery/data-saver.
- **Time integrity:** every sync response includes a **signed time token** `{server_time, device_id, nonce}`; the device stores the last token. Browsers have no persistent monotonic clock (it resets on restart and pauses in sleep), so each continuous run of the app is a **segment** with its own `mono_ms_in_segment`. Server checks: (1) `captured_at_device` must lie within `[token.server_time − tol, received_at + tol]` for the referenced token (rejects future and pre-token timestamps); (2) *within a segment* the drift check is **one-sided**: flag only when `mono_elapsed` exceeds `wall_elapsed` by more than the threshold (monotonic time cannot exceed real time); a large `wall − mono` is expected after sleep or backgrounding and marks the stretch `UNVERIFIABLE`, not `FLAGGED`. Events in a segment that cannot be tied to a token (restart, long sleep, weeks without sync) get `time_trust = UNVERIFIABLE` — accepted, shown to the verifier as lower-trust, never rejected. Violations → `FLAGGED` for verifier review. Defaults: tol 5 min, drift threshold 10 min **[A]**.
  **Limits, stated honestly:** this rule detects clock error and casual tampering. A client that forges `captured_at` and the segment fields consistently inside `[token, received_at]` passes. Fraud defence is the geofence check, satellite evidence, duplicate-polygon checks and verifier spot checks — not the clock rule.
  **Limits, stated honestly:** this rule detects clock error and casual tampering. A client that forges `captured_at` and the segment fields consistently inside `[token, received_at]` passes. Fraud defence is the geofence check, satellite evidence, duplicate-polygon checks and verifier spot checks — not the clock rule.
- **Conflicts:** captures (photos, GPS tracks, practice confirmations) are **append-only facts** and never conflict. Edits to drafts carry `base_version`; fast-forward if current, otherwise `CONFLICT`. **Never offline:** placing orders, payments, retirement, payout/payee changes, consent-revocation confirmation (UI disables with a reason).
- **Device loss / revocation:** the revocation time is the server's `received_at` of the revoke action, and revocation deletes the device's sessions. The sync endpoint therefore also accepts a batch authenticated **by device signature alone** for the single purpose of classification: events from a revoked device are stored as `QUARANTINED` (held, not applied, not discarded) and the response says so. Release requires an institution admin **and a verifier review of the released events** (the agent's attestation alone is not enough, since the agent may not hold the device), subject to the time-trust checks; otherwise they are discarded. Revoked devices are **not issued fresh time tokens**, and signature-only batches are rate-limited. FR-ID-1 and S3.4 use the same rule. Locally stored data is encrypted under a key derived from the agent PIN (WebCrypto).
- Idempotency keys are required on every mutating endpoint (server-side keys retained for the life of the resource).

## 6. FCAE — formal definition (decision D7)

**Units:** whole credits (1 credit = 1 tCO₂e). **Allocation group:** the unit that the cap applies to is the **verified payee account** (falling back to the land-record holder), not the user profile, so one person registering several profiles cannot multiply their share.

**Inputs:** order quantity `Q` (single credit type); per-group available credits `a_g` and `oldest_available_at_g` (summed from the maintained `farmer_available` rows that match the buyer's state/vintage filters, keyed by payee group; `oldest_available_at_g` is the min `available_since` of those AVAILABLE credits and is never reset by a release); tier `τ_g`; `waiting_days_g = ⌊(as_of − max(last_allocated_at_g, oldest_available_at_g)) / 1 day⌋` (whole days). A group that has never been allocated is therefore measured from when it first had inventory (no NULL case), and unsold inventory accumulates priority.

**Weight (integer arithmetic):** `w_g = B[τ_g] · (1000 + min(⌊1000·waiting_days_g / H⌋, 1000·G))` with `B = {Bronze 100, Silver 125, Gold 150, Platinum 200}`, `H = 30`, `G = 3` (config; these are the research variables). `as_of` is read **once** at allocation start and stored in the allocation log, so results are reproducible. No floating point is used, and all intermediate products (`Σw × Q` can reach ~1e17 at 10k groups) use **BigInt / `NUMERIC`**, never JS `Number`.

**Cap:** `cap = max(1, ⌊0.15·Q⌋)` and `x_g ≤ a_g`. For `Q ≥ 7` this is the 15% rule; for `Q < 7` each group receives at most 1 credit (stated explicitly because 15% of a tiny order is below one credit). The cap is **not monotone in Q** (Q = 13 → cap 1 needs ≥ 13 groups; Q = 14 → cap 2 needs ≥ 7), and at pilot scale (fewer than 7 eligible payee groups) large orders always shortfall; an **audited admin override** (`orders.cap_override`, default off) may allow a group to exceed the cap when eligible groups are fewer than the cap implies, and is recorded on the order and in the allocation log.

**Algorithm (weighted water-filling, O(N log N)):**
1. `pg_advisory_xact_lock(class, hash(credit_type))` (two-key form so the namespace does not collide with other advisory locks): one lock per credit type (an order has exactly one); buyer filters (state, vintage) are applied after the lock. Transaction-scoped locks only (safe under PgBouncer transaction pooling). The total lock order in §4.2 applies.
2. **Reap** lapsed reservations of this type (index on `reserved_until`): credit → AVAILABLE, old `order_items.active = false`, aggregates corrected. Then read candidate groups from `farmer_available` (index on `(credit_type)` where `available_count > 0`). Aggregate reads are consistent because every writer of credit state also updates the aggregate in the same transaction under the type lock.
3. `u_g = min(a_g, cap, room_g)` where `room_g = max(0, quota_g − reserved_g)` and `quota_g = max(1, ⌊0.5·(a_g + reserved_g)⌋)`; a **REVALIDATING** order skips `room_g`. If `Σ u_g < Q` → return **shortfall** with the binding reason (`SUPPLY`, `CAP`, or `QUOTA`): the cap is never silently relaxed; the buyer accepts a partial fill or cancels.
4. Water-fill: find the level λ with `Σ min(u_g, λ·w_g) = Q` using exact rational comparison over groups sorted by `u_g / w_g`; groups saturated at `u_g` drop out.
5. Convert to integers with **largest remainder** (exact integer cross-multiplication); tie-break by (`waiting_days` desc, `group_id`), so the outcome is deterministic and sums to exactly `Q`.
6. Pick specific credits per group, oldest vintage first, with `FOR UPDATE SKIP LOCKED`. If a group yields fewer credits than allocated (a concurrent release/freeze that does not hold the type lock), decrement that group's `a_g` and repeat steps 3–5 (at most 3 passes), otherwise return a shortfall. Set `RESERVED` with `reserved_until`; write the allocation log (inputs, weights, `as_of`, outputs) and audit rows, all in one transaction. Freezes and releases also take the type lock, so this is a defensive path.
7. **`farmer_alloc_state.last_allocated_at` is updated only when the order reaches `FULFILLED`** (in the fulfilment transaction), never at reservation or at PAID alone. A buyer who reserves and lets it lapse therefore cannot reset aging and starve the targeted farmers.

**Properties:** (P1) no credit allocated twice, enforced by the database (partial UNIQUE on active `order_items`); (P2) `x_g ≤ max(1, ⌊0.15Q⌋)` unless `cap_override` is recorded on the order; (P3) determinism (same stored inputs ⇒ same output; property-tested with shuffled input order); (P4) every group with inventory has strictly positive weight, so no tier is structurally excluded.
**Caveats for the research claim:** when eligible groups ≫ `Q`, every ideal share is below 1 and the result is a deterministic top-`Q` by `w_g`. Because `w_g` grows with `waiting_days`, this behaves like a **tier-weighted round-robin by waiting time**, which is the intended FCAE behaviour. What separates FCAE from the pure reputation-rank baseline is the *aging term and the cap*; whether that yields better Gini and starvation numbers is what the simulation must show. The "served within K qualifying orders" starvation bound stays a **hypothesis** until measured (SP-5).
**Throughput:** the per-type lock serialises allocations of one credit type; each is a short transaction (target p95 < 200 ms for 10k eligible groups **[A]**). Beyond that: shard the lock by `(credit_type, state)` with consistent key ordering, or batch concurrent orders.
**Redis:** not used in the MVP; if added later it is a read cache only, never authoritative.

## 7. Credit issuance & buffer (decisions D10, D15)

1. Verifier decision `VERIFIED` emits `PlotVerified` (outbox).
2. Issuance job (idempotent on `calc_id`), one transaction: take the type lock for the credit type; require the plot not FROZEN/WITHDRAWN and **no revocation row** for the basis; require `issuance_basis(cycle_id).calc_id` to equal the calculation (the basis row was written by the verifier decision and names the exact calculation the verifier reviewed; UNIQUE per cycle); lock `credit_counters`; compute `net = gross_co2e × (1 − buffer_pct)`; add the `plot_carry_over` remainder; issue `⌊total⌋` whole credits and store the new remainder; add `gross × buffer_pct` to the buffer pool; write audit; outbox `CreditIssued`.
3. **Refresh, correction or new methodology version:** always a new immutable calculation row that `supersedes` the previous one. Before verification the verifier simply sees the latest calculation and the decision selects it as the basis, so better data is never stranded. After the basis exists, a new calculation never changes credits by itself; an admin-approved *delta* handles any difference (positive delta → extra credits through the same job; negative delta → adjustment from the buffer pool or a reversal case). One cycle therefore has exactly one issuance basis. A delta is recorded in `issuance_deltas` and issued idempotently on `delta_id` (its calculation is not the basis, so the `calc_id` check does not apply to it). The verifier decision carries the `calc_id` it reviewed, takes the same cycle lock as MRV, and is **rejected if that calculation is no longer the latest**; a `VERIFIED` decision can be withdrawn before issuance by an `issuance_basis_revocations` row (appeal, spot-check failure, dispute).
4. `buffer_pct` is configuration per methodology and confidence band (default **10% [A]**; lower confidence ⇒ higher buffer). Buffer is held for a permanence period (default 5 years **[A]**); release only by admin action with audit (Q-OQ-1).
5. Methodology interface: `compute(inputs) → {gross_co2e, confidence, trace}`; versioned (`methodology`, `mrv_version`); a calculation row is immutable.
6. Credit ID: `GC-IN-{STATE}-{plot_code}-{YEAR}-{TYPE}-{SEQ}` where `plot_code` is the short plot code (e.g. `PLT239`); SEQ comes from `credit_counters` per `(plot, year, type)`; the column is VARCHAR(48).

## 8. Security, privacy, DPDP

- Authentication via **server-side sessions** (opaque token stored hashed, bound to `device_id` for agents, idle + absolute lifetime); RBAC and tenant checks (institution/agent/farmer) evaluated server-side per request; revoking a user or device deletes its sessions. JWT only for short-lived signed links.
- **Erasure design (crypto-shredding):** every personal-data subject has **per-class** data keys (`subject_keys`: `CONTACT`, `IDENTITY`, `EVIDENCE`, `FINANCIAL_REF`, each wrapped by KMS). PII fields (phone → CONTACT; names and land references → IDENTITY; consent evidence, person images, PII-bearing capture payload fields → EVIDENCE; payee/account references → FINANCIAL_REF) are encrypted under the matching key. Erasure destroys the keys of the classes that may be erased and deletes the blind-index row and the `pseudonyms` mapping, so ciphertext left in append-only tables becomes unreadable; a statutory-retained class (e.g. FINANCIAL_REF) can be kept while the others are shredded. Pseudonymisation alone is **not** treated as erasure, because data stays personal while a re-identification path exists. Records involving several people (joint owners) store each person's fields under that person's own key.
- **Backups and restore:** a point-in-time restore would resurrect a destroyed key row. Therefore every erasure is also written to the `erasure_journal` held **outside** the backup chain, and **replaying the journal (re-destroying keys) is a mandatory, scripted step of every restore** before the system serves traffic. Backup retention is bounded (e.g. 35 days **[A]**) and that bound is stated in the farmer-facing notice. Journal entries carry the key *generation* and a random erasure id, never real identifiers; a subject id is **never reused** after erasure and a new key gets a new generation, so a replay cannot destroy a key created afterwards. `plot_hash` is a **keyed HMAC** (KMS-held key) of the canonical polygon, not an unsalted hash, so it cannot be recomputed from a known boundary; polygon and area are potentially re-identifying and are treated as personal data for access control.
- **Pseudonyms** are random identifiers (not derived from PII) in a deletable mapping; audit and ledger rows reference only the pseudonym; `payload_hash` never covers raw PII, and no bare hash of any low-entropy field is stored anywhere (`capture_events.payload_hmac` is a server-side keyed HMAC). Lookup by phone uses an HMAC blind index with a KMS-held key.
- Retention conflicts (statutory financial records; the deck's 7/10-year retention) are resolved per record class with legal sign-off (Q-OQ-9). Where retention overrides erasure, the data stays encrypted and access-restricted, and the farmer is told which records remain and why.
- Consent per purpose, versioned text in the farmer's language, evidence artefact; revocation moves the plot to `WITHDRAWN` (stops new processing; financial history retained).
- **Hosting in India is a design choice, not asserted as a blanket legal requirement:** the DPDP Act does not impose general localisation, whereas some sectoral rules (e.g. payment data) may. Legal confirmation under Q-OQ-9. Non-Indian services receive synthetic data only.
- Webhook endpoints: signature check on raw body, secret rotation, replay window. Rate limits and bot protection on public endpoints. OTP abuse limits per phone/device/IP **fail closed**: if the limiter store is unavailable, OTP issuance is refused (limit counters are stored in Postgres; Redis is not used in the MVP).
- Secrets in a secrets manager; minter key in KMS (signing calls only); separate keys per environment.

## 9. Disputes & reversal (D5, D10)

| Case | Handling |
|---|---|
| Dispute before sale | Plot and its AVAILABLE credits → `FROZEN`; reservations in flight follow the in-flight rule in §4.2 (void line, re-allocate, or shortfall); the plot's unpaid HELD/RELEASABLE earning lots move to `ON_HOLD` and are excluded from payout batches until resolved (doc 11) |
| Dispute after sale, before retirement | Credit → `REVERSED`; a REPLACEMENT credit from the buffer pool (whole tonnes) goes to the buyer; if the pool lacks whole tonnes the buyer is refunded for that quantity (remedy beyond that: Q-OQ-5) |
| Fraud found after retirement | Row stays RETIRED with `reversed_after_retire = true`; a REPLACEMENT credit is issued and retired for the buyer's reporting period; buyer notified with the reason |
| Farmer's money | The rupee loss is handled by the reversal reserve or receivable policy in §4.1 (never a negative payout) |
| Joint ownership conflict | Plot frozen until the institution resolves it; payee nomination required |
| Farmer-initiated withdrawal | Allowed for AVAILABLE credits; SOLD credits remain; plot → `WITHDRAWN` |
| Malicious dispute | Evidence required; rate limit per raiser; abuse tracked |
| Appeal | Plot owner/agent may appeal once; a second institution reviews (SLA Q-OQ-2) |

## 10. Notifications (accessibility & network)

Farmer-facing events (credit issued, sold, payout sent, verification needed) go by **SMS in the farmer's language** (primary) with optional **IVR callback** (voice prompts); the agent app shows a work queue. Templates are versioned per language; delivery receipts stored; retries on failure; DLT/template registration required for Indian SMS **[A]**.

## 11. Observability & operations

- Golden signals + business invariants dashboards: queue depth, outbox lag, webhook failures, sync backlog by agent, allocation latency, reconcile mismatches.
- Invariant checks (scheduled): no credit SOLD without a PAID order; `Σ ledger` equals `Σ settled payouts + pending`; audit chain verification; credits without a calculation or issuance basis = 0; reservations lapsed longer than one sweep interval = 0 (the sweeper runs the same reap routine, so this holds for quiet types too); `reserved_count` equals a recount of RESERVED credits; every PAID order's items are active and owned by it; `farmer_available` equals a recount of AVAILABLE credits; unreplayed erasure-journal entries = 0.
- **Audit chain:** transactions insert audit rows **unchained** through one write function that assigns `insert_seq` and `insert_mac` at insert time (no lock held through the business commit). `id`/`insert_seq` are insertion order and **not** commit order. A single **chainer worker** assigns `chain_seq` over rows that are *visible* at chaining time and older than the xmin horizon (`xmin::xid8 < pg_snapshot_xmin(pg_current_snapshot())`), then computes `prev_hash`/`hash`; it verifies present-row `insert_mac` and committed chain links/contiguity. `insert_seq` gaps do not prove deletion because sequences can advance on rollback. Pre-chain/tail deletion detection requires an independent durable witness (doc 15). It has UPDATE only on the chain columns. **Horizon protection:** `idle_in_transaction_session_timeout` and `statement_timeout` are set for application roles, and chain lag raises an alert, so one stuck session cannot silently stall chaining and anchoring. **Single active chainer:** a lease row with a fencing token (renewed per batch; not a session advisory lock, which PgBouncer transaction pooling breaks); correctness rests on a UNIQUE `chain_seq`, so a second chainer cannot corrupt the chain. Sizing is for **peak** (~50 sync events/s × audit rows per event), not the ~1 row/s average. Heads are anchored on Polygon Amoy every N minutes (D14). Amoy is a testnet, so anchors demonstrate the mechanism but are not durable evidence until mainnet or an equivalent external timestamp is adopted.
- Backups: PITR, tested restore monthly **including erasure-journal replay**; DR drill documented.

## 12. Capacity & scale path [A]

| Quantity | Estimate at 500K farmers |
|---|---|
| Plots | ~750K |
| Credits/yr | ~2.5M (**[A]** 5 t per farmer per year; aggressive for smallholders and must be validated against MRV outputs, SP-2) |
| Audit rows/yr | ~25M |
| Photos/yr | ~1.5M × 300 KB ≈ 450 GB |
| Agents | ~5K (1 per 100 farmers) |
| Peak sync | ~50 events/s with morning/evening bursts |

Scale path (ordered by trigger): read replica for dashboards → connection pooling (PgBouncer) → partitioning by vintage/month → move heavy workers to separate hosts → shard allocation by market partition → split `notify`/`mrv` modules into services via outbox. Triggers and metrics are listed in [02-tech-stack-adrs.md](02-tech-stack-adrs.md).

## 13. API surface (sketch)

`POST /auth/otp/request|verify` · `POST /sync/batch` · `POST /media/uploads` (resumable) · `GET /plots/:id` · `POST /verifications` · `GET /market/credits` · `POST /orders` → returns `{order_id, price, allocation, shortfall, expires_at, payment_session}` · `POST /orders/:id/cancel` · `POST /webhooks/razorpay` · `GET /farmers/:id/earnings` · `POST /credits/:id/retire` · `GET /certificates/:id` · `GET /admin/invariants` · `POST /consents/:id/revoke`.
