# 01 · Product Requirements Document — GreenChain MVP

Status: Draft v2 · Supersedes `PRD.md` v1.1 · Locked decisions: [MANIFEST.md](../MANIFEST.md) D1–D16 · Sources: deck (Mar 2026), synopsis PDF, research DOCX. **[A]** = assumption; **Q-OQ-n** = open question in the manifest.

## 1. Problem
1. **Financial opacity** — transparency is the weakest-rated trust dimension; many carbon farmers receive no money.
2. **Misplaced trust channels** — farmers trust State Ag Depts, KVKs and local extension networks most; many projects route via actors they trust least.
3. **INR exclusion** — platforms price in USD; no rupee-native, DBT-style settlement.
4. **No fair allocation** — nothing guarantees starvation-free distribution of a bulk corporate order across many eligible farmers.
5. **Unreliable connectivity** — the people who generate the data work where network is intermittent; a design that assumes connectivity excludes them.

## 2. Product principles
INR first · farmer first (assisted, not exclusionary) · consistency for money and credits, availability for field capture · trusted local institutions in the loop · transparency as an engineered property (auditable, statement-able to the farmer) · blockchain as proof only · accessibility as a release gate.

## 3. Goals, non-goals, success metrics

**Goals (MVP):** assisted onboarding with offline capture → verified credits → corporate purchase with fair allocation → auditable INR settlement (sandbox rail) → farmer visibility via SMS (IVR is stretch).

**Non-goals (MVP):** produce marketplace, EcoTrust, donations, contract farming, dual INR/FX market, ads/services, Polygon mainnet, per-farmer wallets, LTCC and TPC credit types (fast-follow), real payout rail, multi-region active-active.

| Metric | Target |
|---|---|
| Double-allocated credits / double payouts | 0 (invariant checks + concurrency tests) |
| Orphan credits (no calculation) | 0 |
| Offline capture success (no data loss across sync) | ≥ 99.9% of events eventually ACCEPTED or explicitly REJECTED with reason **[A]** |
| Agent can onboard a farmer end-to-end offline | Yes, ≤ 15 min per farmer **[A]** |
| Allocation p95 latency at 10k eligible credits | < 200 ms DB time **[A]** |
| Research: Gini, starvation rate vs FCFS & reputation-rank | FCAE better on both; buyer fulfilment completeness not materially worse |
| Time from payment confirmation to payout *initiation* | ≤ 24 h **[A]** |
| Accessibility | WCAG 2.2 AA audit pass; task success ≥ 90% in agent usability test on reference low-end device **[A]** |

## 4. Personas
Farmer (assisted) · Field agent · Institution verifier · Corporate buyer · Admin/auditor. See [03-user-flows.md](03-user-flows.md).

## 5. Scope

| In MVP | Fast-follow | Later |
|---|---|---|
| Assisted onboarding, consent, rights, plots, offline sync | LTCC, TPC | Produce marketplace, EcoTrust, donations |
| Versioned MRV (cached NDVI), verification, STCC issuance with buffer | IVR statements (stretch in MVP) | Contract farming, dual market, mainnet |
| FRPS + weighted FCAE | Verifier report export | Real payout rail, failover gateway |
| Marketplace (price band), orders, Razorpay in, ledger, sandbox payouts | | Ads/services, regional expansion, FRPS-as-credit-score |
| Certificates, retirement, chain proof (Amoy), audit anchoring | | Scope 3, green bonds |
| SMS notifications en/hi/bn | | |

## 6. Functional requirements (with acceptance criteria)

IDs map to stories in [05-backlog-story-points.md](05-backlog-story-points.md) and flows in [04-feature-flows-and-failure-modes.md](04-feature-flows-and-failure-modes.md).

### Identity, consent, KYC (F1)
- **FR-ID-1** Agents authenticate with phone OTP and a registered device; sessions are short-lived; OTP limits fail closed. *AC:* events received from a revoked device are quarantined (held for admin release/discard), never applied.
- **FR-ID-2** Consent captured per purpose, in the farmer's language, with evidence (signature/voice/photo) and version; works offline. *AC:* record without evidence is rejected.
- **FR-ID-3** Farmer phone OTP confirmation and bank/UPI penny-drop name match gate payout setup. *AC:* payout cannot be created for an unverified payee.
- **FR-ID-4** No Aadhaar number or hash stored. *AC:* schema review and data scan confirm.
- **FR-ID-5** Access, correction, withdrawal and deletion requests tracked as tickets with SLA. *AC:* erasure destroys the subject's per-class keys and pseudonym mapping so stored PII becomes unreadable (crypto-shredding), is recorded in an erasure journal kept outside the backup chain, and is re-applied on every restore; audit and ledger remain intact and contain no raw PII.
- **FR-ID-6** Buyers register with GSTIN/CIN and are approved by an admin before ordering. *AC:* unapproved buyer cannot create orders.
- **FR-ID-7** Institutions/verifiers are onboarded with a mandate (region, type). *AC:* a verifier sees only plots within the mandate.

### Land & rights (F2)
- **FR-LND-1** Plot polygon drawn or GPS-walked; area computed server-side. *AC:* area within tolerance of reference.
- **FR-LND-2** Exact duplicate rejected by `plot_hash`; overlap above threshold blocked for review. *AC:* seeded near-duplicate is caught.
- **FR-LND-3** Rights type recorded (owner, or cultivator with owner consent); joint holdings require one nominated payee. *AC:* plot cannot progress without payee when joint.
- **FR-LND-4** Disputes freeze the plot and all its credits. *AC:* frozen credits cannot be reserved.

### Capture & sync (F3)
- **FR-SYN-1** All field actions work offline via outbox; each event has `client_event_id`, device, agent, captured-at. *AC:* airplane-mode onboarding syncs without duplicates after reconnect.
- **FR-SYN-2** Server returns per-event results; client removes only ACCEPTED/DUPLICATE. *AC:* fault-injected drop mid-batch loses nothing.
- **FR-SYN-3** Media uploads are resumable and verified by hash; metadata syncs first. *AC:* upload resumes after interruption.
- **FR-SYN-4** Clock skew and geofence anomalies flag records for verifier review. *AC:* seeded skew/outside-geofence cases are flagged.
- **FR-SYN-5** UI always shows unsynced count and per-item state; transactional actions are disabled offline with a reason. *AC:* order placement unavailable offline.

### MRV (F4)
- **FR-MRV-1** Versioned methodology module computes gross CO₂e, confidence, trace. *AC:* golden tests reproduce outputs; new version creates new rows.
- **FR-MRV-2** NDVI from cached Sentinel-2 exports with provenance (source, date, plot_hash); fallback sources and cloud handling recorded in confidence. *AC:* provenance mismatch is rejected.
- **FR-MRV-3** No credit is issued from mock/placeholder data in production mode. *AC:* guard test.

### Verification (F5)
- **FR-VER-1** Risk-ranked queue (low confidence, flagged, high value, random sample). *AC:* sampler includes configured % of high-FRPS farmers.
- **FR-VER-2** Decision `VERIFIED | NEEDS_VISIT | DISPUTED` with notes and evidence snapshot hash. *AC:* decision is audit-logged and immutable.
- **FR-VER-3** SLA timers and escalation. *AC:* overdue items surface on dashboard **[A: SLA value Q-OQ-2]**.
- **FR-VER-4** A `VERIFIED` decision names the calculation reviewed (`calc_id`), is rejected if that calculation is no longer the latest, and can be withdrawn before issuance by a revocation record. *AC:* a decision on a stale calculation is rejected; a revoked basis cannot be issued; the cycle re-opens for a new decision.

### Registry & buffer (F6, F15)
- **FR-CRD-1** On `VERIFIED`, the decision writes the cycle's `issuance_basis` (the exact calculation the verifier reviewed) and issuance creates whole credits from that basis net of buffer; ID format `GC-IN-{STATE}-{plot_code}-{YEAR}-{TYPE}-{SEQ}`; SEQ collision-free. *AC:* concurrent issuance test produces unique IDs; a second basis for a cycle is impossible; a later calculation changes credits only via an approved delta.
- **FR-CRD-2** State machine `AVAILABLE→RESERVED→SOLD→RETIRED` plus `FROZEN`, `REVERSED`; illegal transitions impossible at DB level. *AC:* transition tests.
- **FR-CRD-3** Buffer pool entry per issuance; reversals consume buffer. *AC:* buffer balance reconciles.
- **FR-CRD-4** Credit cannot exist without a calculation (FK chain). *AC:* invariant job returns 0.

### FRPS (F7)
- **FR-FRP-1** Score 0–1000 derived from event log with the deck's rules (+10 proof, +15 practice, +20 verification, +15 NDVI>0.5, +10 produce sale [later], +20 no violations, −10 late>30d, −25 dispute); recomputable. *AC:* replay equals stored score.
- **FR-FRP-2** Tiers: Platinum 800–1000 (5%), Gold 600–799 (7%), Silver 400–599 (10%), Bronze 0–399 (12%) commission. *AC:* commission snapshot stored on each ledger entry.
- **FR-FRP-3** Anti-gaming: per-period points cap **[A]**, evidence-based events only. *AC:* repeated uploads do not exceed cap.

### Market, orders & FCAE (F8, F9)
- **FR-MKT-1** Buyers browse by type/vintage/state; price band set by admin; price snapshot saved on order. *AC:* price change after order does not alter it.
- **FR-ORD-1** `POST /orders` is idempotent, allocates via FCAE, returns allocation summary and any shortfall. *AC:* same idempotency key → same order.
- **FR-ORD-2** FCAE per technical design §6 (weighted, cap `max(1, ⌊15%·Q⌋)` per allocation group = verified payee account, deterministic, integer arithmetic). *AC:* properties P1–P3 tested; simulation reports P4 and starvation metrics.
- **FR-ORD-3** Reservation lifecycle: 5 min without a confirmed payment attempt; once the gateway confirms an attempt is PENDING the hold extends to confirmation + 15 min, capped at 30 min from allocation **[A]**; lazy expiry plus a sweeper; every move to PAID re-checks credit ownership. *AC:* no reservation remains held more than one sweep interval past `reserved_until`; lapsed reservations are allocatable immediately; a stale order can never mark another order's credits SOLD (race test).
- **FR-ORD-6** An order covers one credit type. Per-buyer and per-payee-group reservation quotas apply **[A]** (≤ 3 open orders and ≤ 10% of eligible supply per buyer; ≤ 50% of a group's available credits reserved). *AC:* quota breaches return a stable error; unpaid orders cannot lock a group's whole inventory.
- **FR-ORD-7** An audited admin cap override may relax the per-group cap at pilot scale; it is recorded on the order and the allocation log. *AC:* default off; any use is visible in the audit trail.
- **FR-ORD-4** Per-buyer limit on concurrent open reservations. *AC:* limit enforced.
- **FR-ORD-5** Shortfall never silently relaxes the cap; buyer chooses partial fill or cancel.

### Payments, ledger & payouts (F10, F11)
- **FR-PAY-1** Razorpay order creation; webhook verified on raw body; processed idempotently in the same transaction as the state change. *AC:* replay and out-of-order tests.
- **FR-PAY-2** Reconciliation job for `PAYMENT_PENDING` orders; late success → re-validate or auto-refund. *AC:* simulated late webhook ends PAID or REFUNDED, never stuck.
- **FR-LED-1** Append-only ledger with gross, commission %, net per farmer per credit; corrections via reversal rows only. *AC:* no UPDATE/DELETE privileges.
- **FR-LED-2** A reversal reserve funded from a configurable share of commission absorbs no-fault reversals; confirmed fraud creates a receivable recovered from the payee's *other* earnings at ≤ 25% per payout (never negative); the fraudulent credit's own unpaid lot is cancelled in full. *AC:* journal balances under any event sequence; payable never negative; reserve exhaustion alerts and never blocks a sale or payout.
- **FR-LED-3** Opening a dispute puts the plot's unpaid lots `ON_HOLD`; a short holdback applies to first-time/Bronze payees. Holdback and recovery are active in sandbox and **gated in production until legal sign-off is recorded**. *AC:* gate closed ⇒ no holdback and no recovery in production; paused lots never enter a batch.
- **FR-PAY-5** Payouts run as a daily batch per payee with a minimum amount (tested on gross lots) and rollover; an unknown rail outcome is resolved by querying the idempotency key before any resend. *AC:* batcher re-run is a no-op; every sandbox failure scenario ends in a defined state; ledger-versus-payout reconciliation diff is 0.
- **FR-PAY-3** Payout port with sandbox adapter; retries with backoff; `NEEDS_REVIEW` after N failures; idempotency key. *AC:* fault-injected failures produce no double payout.
- **FR-PAY-4** Payee change requires re-verification and a cool-off. *AC:* payout to changed payee blocked during cool-off.

### Disputes & reversal (F15)
- **FR-DSP-1** Anyone with a role can raise a dispute with evidence; the plot and its credits freeze; one appeal to a second institution. *AC:* frozen credits cannot be reserved; in-flight orders follow technical design §4.2.
- **FR-DSP-2** Confirmed fraud reverses credits: pre-retirement via REPLACEMENT credits from the whole-tonne buffer (or refund), post-retirement via `reversed_after_retire` + replacement; farmer's rupee loss handled by reversal reserve / receivable, never a negative payout. *AC:* end-to-end tests for all three cases; buffer and reserve reconcile.

### Certificates, retirement, proof (F12, F13)
- **FR-CRT-1** Purchase certificate (credit IDs, tonnes, price, hash, chain tx when available); retirement certificate. *AC:* hash verifiable via URL.
- **FR-CHN-1** Async mint on Amoy `{credit_id, co2e, vintage, farmer_pseudo_id}`; never blocks sales. *AC:* chain outage does not fail an order.
- **FR-AUD-1** Hash-chained append-only audit log; verification job; head hash anchored on chain. *AC:* tamper test detected.

### Notifications & accessibility (F14)
- **FR-NOT-1** SMS to farmers in en/hi/bn for issuance, sale, payout, verification needed; delivery receipts; agent work-queue fallback. *AC:* undelivered SMS creates an agent task.
- **FR-NOT-2** (stretch) IVR statement: balance and recent payments in local language.
- **FR-A11Y-1** WCAG 2.2 AA; icon-first, audio prompts, large targets, sunlight contrast; reference device 2 GB RAM; slow-3G budgets. *AC:* audit and device-lab tests pass.

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Consistency | CP for money/credits (single Postgres primary, synchronous standby); AP at the field edge with deterministic reconciliation |
| Availability | 99.5% monthly for core flows in MVP **[A]**; RPO 0 for committed financial data; RTO ≤ 15 min in-region **[A]** |
| Performance | Allocation p95 < 200 ms DB time; sync batch p95 < 2 s; PWA shell ≤ 200 KB gz; interactive < 5 s on slow 3G **[A]** |
| Scalability | Designed for ~500K farmers in a single region; documented scale path (technical design §12) |
| Security | RBAC, server-side sessions (JWT only for short-lived signed links), envelope encryption, KMS-held keys, signed webhooks, rate limits |
| Privacy | DPDP consent, India-hosted data (design choice; legal basis per Q-OQ-9), crypto-shredding erasure, no PII on-chain or in hash-chained payloads |
| Auditability | Every state change audit-logged in the same transaction; reproducible FRPS; immutable ledger |
| Observability | Business-invariant dashboards, tracing, alerting on queue depth/webhook failures/sync backlog |
| Accessibility | WCAG 2.2 AA, en/hi/bn, voice prompts, low-end device support |
| Data retention | Proofs 7 y; certificates 10 y; verifier reports 7 y (deck); financial records per statutory requirement **[A: confirm]** |

## 8. Research track
Research question and baselines as in the DOCX, with one stated divergence: the DOCX describes a capped, tier-gated round-robin, while the product implements a **weighted water-filling** allocation with an aging term (decision D7). The paper must describe the implemented algorithm and compare it with both baselines. Product hooks: FCAE allocation logs (inputs, weights, outputs) written per order; a simulation harness replays them against FCFS and pure reputation-rank; metrics: Gini, starvation rate, allocation latency, fulfilment completeness, commission-adjusted income spread. Gate: related-work search confirming novelty before committing to the paper claim. Weighted design (D7) and its starvation bound are hypotheses to measure, not claims.

## 9. Dependencies & external risks
Institution partnerships (≥3) · SMS/IVR vendor and DLT template approval · Razorpay account (live) · Sentinel-2 exports for demo plots · legal review (DPDP, payouts, carbon-credit characterisation) · anchor corporate buyers to prove demand · team capacity (Q-OQ-10).

## 10. Traceability (FR → stories → failure-mode section)
Flows are in `03`; failure rows are numbered per feature in `04`; test layers are in `07` §5.

| FR group | Stories (`05`) | Failure modes (`04`) |
|---|---|---|
| FR-ID-1..7 | S1.3, S2.1–S2.6, S3.4, S6.5, S13.1 | F1, F3, F16 |
| FR-LND-1..4 | S4.1–S4.5, S2.4, S7.5 | F2 |
| FR-SYN-1..5 | S3.1–S3.5 | F3 |
| FR-MRV-1..3 | S5.1–S5.4 | F4 |
| FR-VER-1..4 | S6.1–S6.3, S6.6, S6.7 (S6.4 compliance export, stretch) | F5 |
| FR-CRD-1..4 | S7.1–S7.3 | F6 |
| FR-FRP-1..3 | S8.1–S8.3 | F7 |
| FR-MKT-1, FR-ORD-1..5 | S9.1–S9.7 | F8, F9 |
| FR-PAY-1..5, FR-LED-1..3 | S10.1–S10.9, S7.4–S7.7 | F10, F11, F15 |
| FR-DSP-1..2 | S7.4–S7.6 | F15 |
| FR-CRT-1, FR-CHN-1, FR-AUD-1 | S11.1–S11.2, S12.1–S12.3, S1.4 | F12, F13 |
| FR-NOT-1..2, FR-A11Y-1 | S13.1–S13.3, S1.7, S15.3 | F14, cross-cutting a11y |
| Research (§8) | S14.1–S14.3 | – |
| Platform foundation | S1.1, S1.2, S1.5 | F17 |
| NFR hardening | S1.6, S15.1–S15.5 | F17 |
