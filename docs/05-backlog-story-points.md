# 05 · Backlog & Story Points

Status: Draft v1. Points = Fibonacci relative effort (1 ≈ half a day of focused work, 13 ≈ a sprint-week for one dev). **Team size and velocity are unknown (Q-OQ-10)**; planning assumption **[A]**: 2–3 developers, ~30 points per 2-week sprint. Tags: **M** = MVP, **S** = stretch, **R** = risk-heavy (needs spike). Dependencies reference story IDs.

## Epic summary

| Epic | Theme | Points | MVP pts |
|---|---|---|---|
| E1 | Platform foundation | 44 | 44 |
| E2 | Onboarding, consent, KYC | 47 | 47 |
| E3 | Offline capture & sync | 34 | 34 |
| E4 | Land & rights | 23 | 23 |
| E5 | MRV | 24 | 24 |
| E6 | Verification | 35 | 32 |
| E7 | Credit registry, buffer & disputes | 50 | 50 |
| E8 | FRPS | 11 | 11 |
| E9 | Market, orders & FCAE | 54 | 54 |
| E10 | Payments, ledger, payouts | 54 | 54 |
| E11 | Certificates & retirement | 8 | 8 |
| E12 | Blockchain proof | 15 | 15 |
| E13 | Notifications | 21 | 13 |
| E14 | Research harness | 18 | 18 |
| E15 | Hardening & compliance | 26 | 26 |
| **Total** | | **464** | **453** |

(Stretch = S6.4 (3) + S13.2 (8) = 11 points.) After the reversal-reserve and payout designs the MVP is 453 points ≈ 15.1 sprints at 30 points/sprint, so the plan is Sprint 0 plus 15–16 sprints and **the cut list is required**; further candidates: S10.9 RAIL reconciliation can ship with the first live rail, and S7.7 can fold into S7.5. At ~30 pts/sprint the MVP is ≈ **14 sprints (~28 weeks)** of build. The DOCX allows roughly 7 months (≈15 sprints) before the paper-writing phase, and the plan is Sprint 0 plus 14 sprints, so there is **essentially no slack** (the five spikes are not counted); the cut list below is the buffer. Velocity must be re-measured after sprint 2. **Pre-agreed cut list if velocity < 30:** S3.5 offline map tiles (5), S9.6 buyer dashboard detail (5), S11.2 partial retirement (keep full retirement only), S12.3 audit anchoring (5), S6.6 agent scoring beyond cross-institution sampling (5).

## Stories

### E1 Platform foundation
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S1.1 | Repo, CI/CD, IaC, environments, secrets | 5 | M | – | Push → build → deploy to staging; secrets not in repo |
| S1.2 | Postgres baseline schema, migrations, roles (`app_user`, `audit_writer`, workers, `readonly`) | 5 | M | S1.1 | Migrations repeatable; app role has no DELETE |
| S1.3 | OTP auth, server-side sessions (device-bound), RBAC, agent device registration | 8 | M | S1.2, S13.1 | Revoking a device deletes its sessions; events received afterwards are quarantined; OTP limits (Postgres-backed) fail closed |
| S1.4 | Audit log: unchained inserts + single chainer worker + verify job | 8 | M R | S1.2, S1.5 | Tamper detected; concurrent writers do not fork or serialise business transactions |
| S1.5 | Transactional outbox / job queue + worker process | 5 | M | S1.2 | Job enqueued iff transaction commits; retries/backoff |
| S1.6 | Observability + business-invariant checks | 5 | M | S1.1 | Invariant failures alert |
| S1.7 | i18n (en/hi/bn) + accessible component kit + theming | 8 | M | S1.1 | Axe checks pass; font scaling; audio prompt component |

### E2 Onboarding, consent, KYC
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S2.1 | Offline agent onboarding form (farmer, phone, language) | 8 | M | S3.1 | Completes in airplane mode |
| S2.2 | Consent capture with evidence + versioned text | 5 | M | S1.7 | No evidence → rejected |
| S2.3 | Farmer OTP confirmation + `KycPort` penny-drop (sandbox adapter with scenario suffixes), en/hi/bn name matching with scores and review queue, payee cool-off (doc 12 §11) | 8 | M | S1.3, S13.1 | Payout blocked until verified; name variants score as expected on a golden corpus; mismatch never auto-rejects |
| S2.4 | Payee nomination, joint-holding rules and the **payee re-key transaction** (single payee source: `plot_rights`; moves aggregate rows under the type locks) | 8 | M | S4.3 | Joint plot needs payee; allocation group = verified payee account; re-key keeps counts and `sold_payee_group_id` snapshots consistent |
| S2.5 | DPDP rights workflow + per-subject per-class keys, crypto-shredding, erasure journal outside the backup chain with mandatory replay on restore, consent revocation → `WITHDRAWN` | 13 | M R | S1.2 | Erasure makes PII unreadable; a restore drill re-applies erasures; audit and ledger intact; no PII in hash payloads |
| S2.6 | Buyer onboarding: GSTIN/CIN capture, admin approval | 5 | M | S1.3 | Unapproved buyer cannot place orders |

### E3 Offline capture & sync
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S3.1 | IndexedDB outbox + `/sync/batch` with idempotency & per-event results | 13 | M R | S1.3 | Effectively-once under injected drops/duplicates |
| S3.2 | Resumable chunked media upload + compression + `media_complete` gating | 8 | M R | S3.1 | Resumes after interruption; hash verified; MRV/verification wait for `media_complete` |
| S3.3 | Signed time token, skew/drift rules and geofence anomaly flags | 3 | M | S3.1 | Seeded future/backdated/drifting events flagged |
| S3.4 | Device revocation, quarantine + admin release/discard, local data encryption | 5 | M | S1.3 | Events received after revocation are quarantined, never silently applied |
| S3.5 | Offline map tile cache for working areas | 5 | M | S4.1 | Polygon drawable offline |

### E4 Land & rights
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S4.1 | Polygon draw / GPS-walk capture | 8 | M | S3.1 | Area within tolerance |
| S4.2 | `plot_hash` uniqueness + PostGIS overlap detection | 5 | M | S4.1 | Seeded near-duplicate blocked |
| S4.3 | Rights verification workflow (owner / consented cultivator) | 5 | M | S4.1 | Evidence required; freeze on dispute |
| S4.4 | Crop cycles | 3 | M | S4.1 | Cycle linked to plot |
| S4.5 | Short `plot_code` generation (unique per state) | 2 | M | S4.1 | Credit IDs fit VARCHAR(48) |

### E5 MRV
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S5.1 | Methodology interface + documented formula & coefficient sources | 8 | M R | – | Worked example reproduced |
| S5.2 | NDVI cache ingest with provenance & fallback logic | 8 | M R | S4.1 | Provenance mismatch rejected |
| S5.3 | Confidence score + buffer % calculation | 5 | M | S5.1 | Buffer varies by confidence band |
| S5.4 | Golden tests & determinism checks | 3 | M | S5.1 | Same inputs → same output |

### E6 Verification
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S6.1 | Verifier queue with risk ranking & SLA timers | 8 | M | S5.3, S3.3 | Risk order verified in tests |
| S6.2 | Review UI + decisions with evidence snapshot hash | 8 | M | S6.1 | Decision immutable & audited |
| S6.3 | Random spot-check sampler | 3 | M | S6.1 | Sampling % honoured |
| S6.4 | Compliance report export | 3 | S | S6.2 | CSV/PDF export |
| S6.5 | Institution / verifier onboarding, mandates, region assignment | 5 | M | S1.3 | Verifier sees only plots in mandate |
| S6.6 | Agent scoring and collusion controls (cross-institution re-verification sample, approve-rate anomalies) | 5 | M | S6.2 | Seeded colluding agent is surfaced |
| S6.7 | Verifier decision carries `calc_id`, cycle-lock check against the latest calculation, and `issuance_basis_revocations` (withdraw before issuance) | 3 | M | S6.2 | Stale decision rejected; revoked basis cannot be issued; cycle re-opens |

### E7 Credit registry & buffer
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S7.1 | Issuance job from `issuance_basis` (UNIQUE per cycle), `credit_counters`, whole credits, `plot_carry_over`, delta handling | 8 | M R | S6.2, S5.3, S4.5 | Concurrent issuance gives unique IDs; retry is a no-op; new methodology version cannot double-issue |
| S7.2 | Credit state machine with DB-level guards (incl. FROZEN, REVERSED, `reversed_after_retire`) | 5 | M | S7.1 | Illegal transitions fail |
| S7.3 | Buffer pool accounting in whole tonnes + reconciliation | 5 | M | S7.1 | Buffer balance reconciles |
| S7.4 | Reversal: REPLACEMENT credits from buffer, ledger reversal, post-retirement path | 13 | M R | S7.3, S10.4 | Pre-sale, post-sale and post-retirement reversals pass end-to-end tests |
| S7.5 | Dispute raise / evidence / freeze / appeal workflow | 8 | M | S7.2, S6.5 | Frozen credits cannot be reserved; in-flight orders follow the §4.2 rule |
| S7.6 | Reversal reserve and receivable accounting: journal, posting rules E1–E10, funding, absorb, recovery planner, parking/idempotency, reconciliation invariants (doc 11) | 8 | M R | S10.4, S7.4 | Journal always balances; payable never negative; recovery ≤ 25% per payout; duplicate or shuffled events are no-ops |
| S7.7 | Dispute pause: `ON_HOLD` lot state on dispute open/resolve, set-off cancellation on confirmed fraud (doc 11 §5) | 3 | M | S7.5, S10.8 | Paused lots never enter a batch; resolution restores prior state; fraud set-off cancels the lot in full |

### E8 FRPS
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S8.1 | `frps_events` + derived score + nightly recompute | 5 | M | S6.2 | Replay equals stored |
| S8.2 | Tiers & commission snapshots | 3 | M | S8.1 | Snapshot on ledger rows |
| S8.3 | Anti-gaming caps & fault attribution | 3 | M | S8.1 | Caps enforced |

### E9 Market, orders & FCAE
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S9.1 | Inventory browse, price lists (commit-time margin, completeness, two-sided tax coverage, withdraw), tax rules, order-time price/tax and commission snapshots, priced-key filter | 10 | M | S7.2 | Snapshot immutable; list cannot go effective without prices and tax coverage; unpriced stock excluded; a missing rule cannot fail a paid order |
| S9.2 | FCAE engine (weighted water-filling, cap, rounding, determinism) | 13 | M R | S7.2, S8.2 | P1–P3 property tests pass |
| S9.3 | Order API, idempotency, order state machine | 8 | M | S9.2 | Same key → same order |
| S9.4 | Reservation sweeper, per-buyer and per-group reservation quotas, hold extension on confirmed PENDING, ownership check on PAID | 5 | M | S9.3 | No reservation past TTL; stale order cannot sell another order's credits; quotas enforced |
| S9.5 | Concurrency & race test suite | 5 | M R | S9.3 | 0 double allocations under load |
| S9.6 | Buyer dashboard: targets, purchased, retired | 5 | M | S9.3 | Totals reconcile |
| S9.7 | Aggregate by (group, type, state, vintage) with `reserved_count`, quotas, `available_since`, `farmer_alloc_state` updates at FULFILLED, allocation log, tier projection by event sequence with bootstrap | 8 | M | S7.2 | Aggregate equals recount; quotas enforced with distinct shortfall reasons; lapsed reservations cannot reset aging; stale tier events ignored |

### E10 Payments, ledger, payouts
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S10.1 | Razorpay order + signed, idempotent webhook | 8 | M | S9.3 | Replay & out-of-order safe |
| S10.2 | Reconciliation poller | 5 | M | S10.1 | Stuck orders resolved |
| S10.3 | Late-success re-validate / auto-refund | 5 | M R | S10.1 | Never stuck |
| S10.4 | Append-only ledger + commission | 5 | M | S10.1, S8.2 | No UPDATE/DELETE possible |
| S10.5 | Payout component: `PayoutPort`, deterministic sandbox adapter with `SandboxControl`, daily batcher with rollover and recovery hook, payout state machine incl. INDETERMINATE/RETURNED/CANCELLED, send job and resolver (doc 12) | 13 | M R | S10.4, S2.3 | No double payout under injected faults; unknown outcome resolved by key query; batcher re-run is a no-op |
| S10.6 | Farmer statements (API + agent view) | 3 | M | S10.4 | Matches ledger |
| S10.7 | Invoicing and tax lines (rules per Q-OQ-3; rounding of paise and gateway fees defined) | 5 | M | S10.1 | Invoice totals reconcile to ledger |
| S10.8 | Earning lots, holdback releaser job, legal gate (`legal_gate_confirmed`) and `ledger_config` two-person publication (doc 11 §4, §9) | 5 | M | S10.4 | Gate closed ⇒ lots start RELEASABLE and R = 0 in production; open ⇒ holdback and recovery apply |
| S10.9 | Payout reconciliation: INTERNAL conservation and RAIL statement matching, alerts (doc 12 §12) | 5 | M | S10.5 | Seeded mismatches (suffixes 12/13) page; matching items resolve SENT → SETTLED |

### E11 Certificates & retirement
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S11.1 | Purchase certificate PDF + verification URL | 5 | M | S10.1 | Hash verifies |
| S11.2 | Retirement flow & certificate | 3 | M | S11.1 | RETIRED terminal |

### E12 Blockchain proof
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S12.1 | Solidity contract + Hardhat tests (duplicate rejection, pause) | 5 | M | – | Tests pass |
| S12.2 | KMS-signed mint worker, idempotent, async | 5 | M | S12.1, S1.5, S7.1 | Chain outage doesn't block sale |
| S12.3 | Audit head-hash anchoring | 5 | M | S1.4, S12.1 | Anchor verifiable |

### E13 Notifications
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S13.1 | SMS adapter + templates (en/hi/bn) + receipts | 8 | M | S1.5 | Receipts stored; fallbacks |
| S13.2 | IVR statement | 8 | S | S10.6 | Spoken balance in local language |
| S13.3 | Agent work-queue for undelivered notifications and follow-ups | 5 | M | S13.1 | Undelivered SMS → task |

### E14 Research harness
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S14.1 | Allocation simulator (synthetic farmers/orders at scale) | 8 | M | S9.2 | Reproducible seeds |
| S14.2 | Baselines: FCFS and pure reputation-rank | 5 | M | S14.1 | Same inputs, comparable outputs |
| S14.3 | Metrics & report (Gini, starvation, latency, completeness, income spread) | 5 | M | S14.2 | Charts + tables |

### E15 Hardening & compliance
| ID | Story | Pts | Tag | Deps | Key acceptance |
|---|---|---|---|---|---|
| S15.1 | Chaos / partition tests (DB failover, webhook storms, sync drops) | 8 | M R | most | Invariants hold |
| S15.2 | Load test (sync bursts, allocation, listing) | 5 | M | S9.3 | Meets NFRs |
| S15.3 | Accessibility audit + low-end device lab + slow-network tests | 5 | M | S1.7 | WCAG AA pass; budgets met |
| S15.4 | Security review + DPDP checklist | 5 | M | – | No Critical open |
| S15.5 | Backup/restore + DR drill | 3 | M | S1.2 | Restore verified |

## Spikes (time-boxed, before dependent stories)
1. **SP-1 Sync viability** (3 days): IndexedDB quota/eviction on target devices; decide PWA vs wrapper.
2. **SP-2 MRV formula** (5 days): choose emission factor tables and write the worked example.
3. **SP-3 Payout & KYC legal path** (3 days, non-code): what is needed for real payouts and penny-drop.
4. **SP-4 SMS DLT approval lead time** (2 days, non-code).
5. **SP-5 FCAE proof sketch** (3 days): starvation bound vs simulation evidence.
