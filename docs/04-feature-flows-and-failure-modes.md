# 04 · Feature Flows & Failure Modes

Status: Draft v1. For every feature: **flow**, **invariants**, and a **failure table** (Detect → Recover). Checklist used per feature: network · concurrency · idempotency · clock · partial failure · data loss · abuse/collusion · privacy/deletion · scale · accessibility.

Severity: 🔴 money/credit integrity or legal · 🟠 data quality/trust · 🟡 UX/ops.

Implementation detail: [feature specifications](features/README.md) expand each flow with ownership, application contracts, security, scaling and acceptance checks. Read the [shared contracts](features/common-contracts.md) and [design clarifications](features/design-issues.md) before implementing a transition described here.

---

## F1 · Identity, consent & KYC
**Invariants:** no payout without OTP-verified phone + penny-drop name match; no Aadhaar stored; consent versioned and evidenced.

| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Farmer has no phone / shared phone; same person registers under several profiles to beat the per-farmer cap | 🟠 | Phone uniqueness is a warning, not a block. The **allocation group is the verified payee account** (fallback: land-record holder), so extra profiles do not multiply share; duplicate payee accounts across profiles are flagged for review |
| 2 | OTP can't be delivered at onboarding (no signal) | 🟡 | Onboarding completes offline; payout stays blocked until OTP verified; work-queue reminder to agent |
| 3 | Name on land record ≠ bank name (spelling/transliteration) | 🟠 | Fuzzy match with threshold; below threshold → verifier/manual review; never auto-reject |
| 4 | Agent fabricates consent | 🔴 | Evidence artefact required (signature/voice/photo); consent without evidence rejected; **MVP verification is a random human callback by institution staff** (IVR automation is a later improvement, S13.2) |
| 5 | OTP abuse / SIM swap | 🟠 | Rate limits per phone/device/IP; payout change requires re-verification and cool-off |
| 6 | Minor / incapacitated holder | 🟠 | Guardian/nominee workflow, institution attestation required |
| 7 | Language mismatch (consent in wrong language) | 🟠 | Consent text language stored; mismatch with farmer language blocks completion |

## F2 · Land registration & rights
**Invariants:** one active claim per area; owner or consented cultivator; one nominated payee for joint holdings.

| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Same plot registered twice (exact) | 🔴 | `plot_hash` UNIQUE → reject, show existing claim to institution |
| 2 | Overlapping/shifted polygon (near-duplicate) | 🔴 | PostGIS intersection above threshold (e.g. > 20% **[A]**) → block + review; gaming attempt feeds anti-gaming score |
| 3 | Joint owners disagree on payee | 🟠 | Plot cannot progress; institution mediation; frozen state |
| 4 | Tenant farms, owner absent | 🟠 | Owner consent document (photo + verifier attestation); expiry date; consent revocation freezes plot |
| 5 | GPS drift/poor accuracy | 🟡 | Accuracy threshold per capture; re-walk prompt; allow polygon edit before verification |
| 6 | Land-record lookup unavailable | 🟡 | Manual reference with attestation; verifier validates against state record offline |
| 7 | Plot boundary changes later (sale, partition) | 🟠 | Re-registration flow; credits tied to the old polygon stay valid, new vintage uses new claim |

## F3 · Capture & offline sync
**Invariants:** at-least-once delivery + dedup ⇒ effectively-once; captures append-only; transactional actions never offline.

| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Connection drops mid-batch | 🟡 | Per-event results; only ACCEPTED/DUPLICATE removed from outbox; resume |
| 2 | Duplicate submit (double tap, retry) | 🟠 | `(device_id, client_event_id)` UNIQUE ⇒ DUPLICATE |
| 3 | Device clock wrong/tampered (future, backdated, or drifting timestamps) | 🟠 | Signed server time token + monotonic-clock drift check (technical design §5) ⇒ `FLAGGED` for review, never dropped |
| 4 | Browser evicts IndexedDB / storage full | 🔴 | Persistent-storage request, quota monitor, warn at 80%, block new capture at 95%; “unsynced items” banner; fallback to native wrapper (ADR-003) |
| 5 | Device lost/stolen with unsynced data | 🟠 | Revocation takes effect at the server's receive time; later events from that device are **QUARANTINED**, and an institution admin releases or discards them after the agent attests; device data encrypted (key under agent PIN); data truly lost ⇒ re-capture task generated |
| 6 | Large media on 2G | 🟡 | Compression, chunked resumable upload, metadata-first, background sync, data-saver mode |
| 7 | Same entity edited on two devices | 🟠 | Append-only facts; draft merge with conflict log; verifier sees both |
| 8 | Sync thundering herd after regional outage | 🟠 | Server-side rate limit per agent + `Retry-After`, client jitter |
| 9 | Schema/app version skew (old app, new API) | 🟠 | Versioned event schema; server accepts N−2; forced-update flag only when unsafe |
| 10 | Server accepts event but crashes before ack | 🟡 | Client retries ⇒ DUPLICATE (same key and same payload hash) |
| 11 | Same key reused with a different payload | 🟠 | `REJECTED(KEY_REUSE)`, flagged; client never silently drops the changed event |
| 12 | Event whose predecessor is missing/failed | 🟡 | `DEFERRED` up to 30 days; if the predecessor is REJECTED the dependent is surfaced in “needs fix” |
| 13 | Permanently invalid event loops forever | 🟡 | `REJECTED` moves to “needs fix”; never auto-retried |
| 14 | Media arrives after the event is accepted, or never | 🟠 | `media_complete` gates MRV/verification; overdue incomplete media creates an agent task |

## F4 · MRV & calculation
**Invariants:** calculation immutable & versioned; no issuance on mock data; confidence recorded.

| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Cloud cover ⇒ no clean NDVI | 🟠 | Fallback chain Sentinel-2 → Landsat-9 → Bhuvan; temporal interpolation; confidence drops; below minimum ⇒ `NEEDS_VISIT` |
| 2 | Methodology change (re-run for a cycle that already issued credits) | 🔴 | New `mrv_version` ⇒ new immutable calculation row that `supersedes` the old one. Credits are issued only from the cycle's single `issuance_basis` (UNIQUE per cycle, written by the verifier decision); after the basis exists only an admin-approved *delta* can add or adjust credits, so one cycle can never be issued twice and better data before verification is never stranded |
| 3 | Cached export stale/wrong plot | 🔴 | Provenance (source, date, plot_hash) checked before use; mismatch ⇒ reject |
| 4 | Non-deterministic result | 🟠 | Pure function of stored inputs; regression tests with golden outputs |
| 5 | Over-crediting (scientific uncertainty) | 🔴 | Buffer % by confidence band; conservative defaults; publish methodology note |
| 6 | Worker crash mid-calculation | 🟡 | Idempotent: UNIQUE `(cycle_id, methodology_version_id, inputs_hash)` plus an advisory lock per cycle (see [08](08-mrv-module-design.md)) |

## F5 · Verification
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Verifier backlog | 🟠 | Risk-ranked queue, SLA timers, auto-escalation, satellite-first rule, load dashboard |
| 2 | Verifier–agent collusion | 🔴 | Random cross-institution re-verification, ratio anomalies (approve rate, disputes reversed), geofence of verifier visits, rotating assignment |
| 3 | Verifier decision made on stale evidence | 🟠 | Decision stores evidence snapshot hash; newer evidence ⇒ re-open |
| 4 | Verifier unavailable region | 🟡 | Fallback institution mapping by admin |
| 5 | Wrongful dispute | 🟠 | Appeal path, SLA, FRPS penalty reversal |
| 6 | Calculation changes between the verifier's review and the decision | 🟠 | The decision carries the reviewed `calc_id`, takes the same cycle lock as MRV, and is rejected if it is no longer the latest (doc 08 §7) |
| 7 | A VERIFIED decision must be withdrawn before issuance (appeal, spot-check failure, dispute) | 🟠 | Append-only `issuance_basis_revocations` row; the registry re-checks it under its lock; the cycle re-opens for a new decision |

## F6 · Credit issuance & buffer
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Concurrent issuance ⇒ SEQ collision | 🔴 | `credit_counters` row lock + UNIQUE credit_id |
| 2 | Issuance job retried | 🔴 | Idempotent on `calc_id`; second run is a no-op |
| 3 | Fractional tonnes | 🟡 | Whole-credit issuance, carry-over remainder |
| 4 | Credit exists without calc | 🔴 | NOT NULL FK; invariant check job |
| 5 | Buffer exhausted by reversals, or pool holds < 1 whole tonne | 🟠 | Alert at 70%; raise buffer % for new issuance; replacement only in whole tonnes, otherwise refund the quantity; admin review (Q-OQ-5) |
| 6 | Tiny plots never reach one whole credit | 🟡 | `plot_carry_over` accumulates remainders across cycles/vintages |

## F7 · FRPS
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Score gaming via fake proofs | 🟠 | Rules fire only on verified evidence; diminishing returns per period (cap on points/month **[A]**) |
| 2 | Score drift / bug | 🟠 | Score is derived from `frps_events` (replayable); nightly recompute and diff |
| 3 | Unfair penalties from agent error | 🟠 | Attribution field (farmer vs agent fault); appeal; penalty reversal event |
| 4 | New farmer starts Bronze, little allocation | 🟠 | Weighted FCAE (D7) gives Bronze positive weight + aging; monitored via starvation metric |

## F8 · Marketplace & pricing
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Stale inventory shown | 🟡 | “Last updated” stamp; availability re-validated on order |
| 2 | Price manipulation/mispricing | 🔴 | Admin-set price band per type/vintage, changes audited, price snapshot stored on the order |
| 3 | Unsold inventory aging | 🟠 | Visibility to farmers (“unsold”), SMS expectations, admin reports, aging boosts FCAE weight |
| 4 | GST/TDS treatment unclear | 🟠 | Open question Q-OQ-3; tax lines stored separately on the invoice |

## F9 · Order & FCAE allocation
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Two buyers want the same credits | 🔴 | Per-market advisory lock + row locks + UNIQUE active `order_items.credit_id` |
| 2 | Supply < order or cap infeasible | 🟠 | Explicit shortfall; buyer accepts partial or cancels |
| 3 | Reservation expires during payment | 🔴 | Reservation extension while attempt in flight; hard max; sweeper |
| 4 | Buyer abuses reservations (hoarding, or unpaid orders locking the top-weight groups) | 🟠 | Per-buyer quotas, per-group reserved-share cap, hold extends only after the gateway confirms PENDING, short base TTL, rate limiting |
| 4b | Lapsed reservation taken over while the old order's payment succeeds | 🔴 | Ownership check on every PAID transition; mismatch ⇒ REVALIDATING/REFUND_PENDING; takeover deactivates old `order_items`; total lock order (06 §4.2) |
| 4c | Same order paid twice | 🟠 | Duplicate success recorded, second payment refunded, order unchanged |
| 5 | Allocation latency spike | 🟡 | Index on `(status, type, vintage)`, partitioning, p95 alert |
| 6 | Optional cache unavailable (Redis is not used in the MVP) | 🟡 | Not on the critical path; Postgres is authoritative (ADR-004) |
| 7 | Request retried by client | 🔴 | Idempotency key ⇒ same order returned |
| 8 | Buyer reserves and lets it lapse to reset farmers' aging | 🟠 | `last_allocated_at` changes only when an order is PAID/FULFILLED |
| 9 | A credit is frozen while its order is in flight | 🔴 | Void the line and re-allocate (before or after PAID, before FULFILLED); else shortfall / pro-rata refund (technical design §4.2) |
| 10 | Allocation scans millions of credits | 🟠 | Maintained `farmer_available` aggregate; per-credit-type advisory lock; shard by `(type, state)` if needed |
| 11 | Order smaller than 7 credits and the 15% cap | 🟡 | Cap is `max(1, ⌊0.15Q⌋)`, documented; at most 1 credit per group for tiny orders |
| 12 | Quota blocks an order that supply and cap would allow (a group holding 1–2 credits, or an order above 10% of supply) | 🟡 | Per-group quota is `max(1, ⌊0.5·(available+reserved)⌋)`; the shortfall reports reason `QUOTA`; paid orders re-validating are exempt; the buyer can split the order or wait |
| 13 | Credits issued after the price list was published have no price | 🟠 | Priced-key filter excludes them from allocation and lists them for admins, so priced stock still fills the order (doc 09 §4) |
| 14 | Filtered order over-counts availability | 🟠 | Aggregate keyed by (group, type, state, vintage), so filters match exactly (06 §3, §6) |

## F10 · Payments in & webhooks
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Duplicate webhook | 🔴 | `payment_events.provider_event_id` UNIQUE, same transaction as state change |
| 2 | Webhook out of order | 🔴 | State rank for non-success events; success events always go through the late-success rule |
| 3 | Webhook never arrives | 🔴 | Reconciliation job polls the provider for orders in `AWAITING_PAYMENT` |
| 4 | Late success after expiry or cancellation | 🔴 | `REVALIDATING`: re-reserve the same credits all-or-nothing, else full auto-refund; all audited |
| 4b | Payment fails, buyer wants to retry | 🟡 | Several payment attempts per order within the reservation cap (30 min **[A]**) |
| 5 | Webhook forged | 🔴 | HMAC on raw body; secret rotation |
| 6 | Amount mismatch | 🔴 | Compare with order price snapshot ⇒ hold + alert |
| 7 | Gateway outage | 🟠 | Clear UX, no new reservations beyond limit, failover provider later |
| 8 | Chargeback/refund after fulfilment | 🔴 | Treated like a reversal (technical design §9): credit REVERSED (or `reversed_after_retire` + REPLACEMENT if already retired), ledger reversal rows, loss borne per §4.1 policy (Q-OQ-4/5) |
| 9 | Commission-side tax rule expired or missing between order and fulfilment | 🔴 | Commission and its tax are snapshotted at allocation and copied by the ledger, so the paid order cannot fail at FULFILLED (doc 09 §3); publish validation covers both sides |

## F11 · Ledger, settlement & payouts
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Payout fails | 🟠 | Retries with backoff, `NEEDS_REVIEW` after N, farmer SMS only on resolution |
| 2 | Wrong payee after SIM change/account change | 🔴 | Payee change = re-verification + cool-off; first payout after change flagged |
| 3 | Double payout | 🔴 | Idempotency key on payout port; ledger states |
| 4 | Ledger/payout mismatch | 🔴 | Scheduled reconciliation; any non-zero diff pages ops |
| 5 | Commission wrongly applied | 🟠 | Tier snapshot stored on the entry; recompute check |
| 6 | Farmer disputes amount | 🟠 | Ledger statement per credit; agent/IVR statement; dispute ticket |
| 7 | Payout outcome unknown (timeout, crash between call and record) | 🔴 | State INDETERMINATE; query the rail by idempotency key before any resend; unresolved after 24 h ⇒ NEEDS_REVIEW (doc 12 §7) |
| 8 | A dispute opens while a farmer's lots are releasable | 🟠 | Lots go `ON_HOLD` and are excluded from batches until resolved; lots already IN_BATCH or PAID are handled by receivable/absorb rules (doc 11 §5) |
| 9 | Reserve exhausted when a no-fault reversal posts | 🟠 | Absorb up to the balance, residual left on `reversal_loss`, alert and finance escalation; never blocks a sale or payout (doc 11 §8) |
| 10 | Recovery would exceed 25% of a payout, or the minimum is not reached | 🟡 | Recovery floored at ⌊25%·S⌋; the minimum is tested on gross lots, so nothing is recovered or paid until it is met (doc 11 §6) |

## F12 · Certificates & retirement
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Certificate generation fails | 🟡 | Retry job; order stays FULFILLED; certificate status separate |
| 2 | Retire same credit twice | 🔴 | State machine; RETIRED terminal |
| 3 | Buyer retires then fraud is discovered | 🔴 | Row stays RETIRED with `reversed_after_retire = true`; a REPLACEMENT credit from the buffer is issued and retired for the buyer's period (technical design §9) |
| 4 | Certificate tampering | 🟠 | Hash stored in audit, verification URL, chain proof when available |

## F13 · Blockchain proof & audit anchoring
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Chain/RPC down | 🟡 | Async retry; never blocks sale or payout; “proof pending” label |
| 2 | Duplicate mint | 🟠 | Contract rejects duplicate `credit_id`; job idempotent |
| 3 | Minter key compromise | 🔴 | KMS, access policy, rotation runbook, pause-contract switch |
| 4 | Gas/testnet faucet exhausted | 🟡 | Balance alert |
| 5 | Audit chain fork or serialised transactions under concurrent writers | 🔴 | Unchained inserts + a single chainer worker (one chain; shard by aggregate hash only if chaining lag is measured); verification job |
| 6 | Deletion request vs immutable chain | 🟠 | Nothing personal on-chain; random per-subject pseudonym in a deletable mapping (not a derived HMAC); erasure destroys the mapping and subject key |
| 7 | Amoy testnet anchors are not durable evidence | 🟡 | Declared as a mechanism demo; mainnet/external timestamp is the upgrade path |

## F14 · Notifications (SMS/IVR)
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | SMS not delivered | 🟠 | Delivery receipts; agent work-queue item (the agent tells the farmer in person); IVR is a later fallback (S13.2) |
| 2 | Wrong language/template | 🟡 | Template per language/version; fallback to Hindi/English |
| 3 | DLT template not approved | 🟡 | Launch blocker checklist item |
| 4 | Notification spam/cost | 🟡 | Batching, quiet hours, per-farmer daily cap |
| 5 | Sensitive data in SMS | 🟠 | Amounts and credit IDs only; no land or ID details |

## F15 · Disputes & reversal
Covered in technical design §9; failure rows: dispute during in-flight order (complete or cancel deterministically), reversal exceeding buffer (admin escalation, buyer remedy policy Q-OQ-5), malicious dispute (rate limit + evidence requirement).

## F16 · DPDP & data rights
| # | Failure | Sev | Detect → Recover |
|---|---|---|---|
| 1 | Deletion requested for data under legal retention | 🟠 | Crypto-shred what can be erased; retained records stay encrypted and access-restricted; document the legal basis (Q-OQ-9) and tell the requester. Pseudonymisation alone is not treated as erasure |
| 2 | Consent withdrawn mid-lifecycle | 🟠 | Stop processing for new events; existing financial records retained; plot enters `WITHDRAWN` |
| 3 | Breach | 🔴 | Incident runbook, 72 h notification process **[A: confirm legal window]** |
| 4 | Backups contain deleted PII | 🟠 | Backup retention window documented; restore procedure re-applies deletions |

## F17 · Admin, observability & operations
Failure rows: invariant check failure (page ops), runaway queue depth (autoscale/alert), bad deploy (rollback, feature flags), expired secrets/certs (expiry alerts), DR restore failure (monthly restore test), noisy-neighbour verifier uploads (rate limits).

## Cross-cutting: accessibility failures

| Failure | Mitigation |
|---|---|
| Agent can't read screen in sunlight | High-contrast theme, large fonts, audio prompts |
| Low literacy farmer misunderstands consent | Spoken consent in local language, teach-back confirmation recorded, SMS/IVR summary |
| Screen reader users (verifiers/buyers) | WCAG 2.2 AA, semantic HTML, keyboard paths, audit before release |
| Language errors | Professional translation + review by native speaker; glossary |
| Low-end device crashes | Memory budget, lazy loading, no heavy maps while capturing, crash telemetry |
