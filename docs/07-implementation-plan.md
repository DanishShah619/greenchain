# 07 · Implementation Plan

Status: Draft v2 · Based on [05-backlog-story-points.md](05-backlog-story-points.md) (464 points, 453 MVP). Capacity unknown (Q-OQ-10); schedule assumes **[A]** 2–3 devs, 2-week sprints, ~30 pts/sprint ⇒ Sprint 0 plus **15–16 sprints**, which exceeds the ≈15-sprint DOCX build window by about one sprint (the cut list is required, not optional). Re-plan after sprint 2 using measured velocity; the pre-agreed cut list is in the backlog.

## 1. Critical path
`Schema/Auth/Audit/Outbox (E1)` → `Sync + capture (E3)` → `Land (E4)` + `MRV (E5)` → `Verification (E6)` → `Issuance (E7)` → `FCAE + Orders (E9)` → `Payments/Ledger/Payouts (E10)` → `Certificates + Chain (E11/E12)`. Research harness (E14) depends only on FCAE (S9.2) and can run in parallel after it. Non-code lead items (institution partnerships, DLT, legal, Razorpay account) start in Sprint 0.

## 2. Phases and sprints

| Phase | Sprints | Focus | Exit criteria |
|---|---|---|---|
| 0 Foundations | S0 (wk 1–2) | Review D1–D16 and decide the CONFIRM ADRs; spikes SP-1…SP-5; related-work search; S1.1, S1.2 | Spike outcomes recorded; CONFIRM items decided; risks re-ranked |
| 1 Platform & capture | Sprints 1–3 (≈ 100 pts of content; spills slightly into sprint 4) | S1.3–S1.7, **S13.1 (SMS adapter, needed by OTP)**, S2.1–S2.3, S3.1–S3.4, S4.1 | Agent onboards a farmer and a plot offline; sync proven under fault injection; audit chain verified |
| 2 Evidence → credits | Sprints 4–7 (≈ 108 pts) | S4.2–S4.5, S5.1–S5.4, S6.1–S6.3, S6.5, S7.1–S7.3, S8.1–S8.3, S2.4, S2.6, S6.7 | Verified plot yields credits with buffer; FRPS live; buyers and verifiers onboard |
| 3 Market & money | Sprints 7–11 (≈ 161 pts ≈ 5.4 sprints; heaviest phase, applies the cut list first; sprint boundaries are cumulative by points and approximate) | S9.1–S9.7, S10.1–S10.9, S11.1–S11.2, S7.4–S7.7, S2.5 | Buyer buys, pays (sandbox), ledger/payout recorded, certificate issued; races, webhook faults and reversal paths pass |
| 4 Proof, comms, research | Sprints 12–13 (≈ 48 pts) | S12.1–S12.3, S13.3, S14.1–S14.3, S6.6, S3.5 | Mint + anchoring on Amoy; agent work queue; research results on synthetic data |
| 5 Hardening & demo | Sprint 14 | S15.1–S15.5, bug fixes, demo data, usability test | NFR checks, chaos, a11y audit pass; demo-ready E2E; real test-user transactions |
| 6 Paper & submission | Months 8–9 | Re-run evaluation on real logs; IMRaD draft; submission | Per DOCX roadmap |

Phase 2 has the heaviest load; if velocity is under 30 apply the cut list from the backlog (S3.5, S9.6 detail, partial retirement, S12.3, S6.6 extras). Stretch (only if ahead): S6.4, S13.2. Story dependencies in `05` are authoritative for ordering within a phase.

## 3. Environments & delivery
dev (local Docker: Postgres+PostGIS, mock gateways) → staging (Indian region, synthetic data) → prod/demo. Trunk-based development, PR review, migrations forward-only with expand/contract, feature flags for risky modules, rollback runbook. Seed/fixtures for demo plots (cached NDVI) kept in-repo.

## 4. Definition of done (per story)
Code + unit tests; integration test for any DB/transaction path; failure-mode rows from `04` covered by a test or an explicit accepted-risk note; audit entries emitted; i18n strings externalised; a11y checks pass; docs/ADR updated; observability (logs/metrics) present; feature flag defaults safe.

## 5. Test strategy

| Layer | Focus | Examples |
|---|---|---|
| Unit | Pure logic | FRPS rules, methodology functions (golden), FCAE rounding/determinism, state-machine guards |
| Property-based | FCAE | cap respected, no over-allocation, deterministic under shuffled inputs |
| Integration | DB/transactions | issuance idempotency, order+reservation, webhook idempotency, ledger immutability (privilege tests) |
| Concurrency | Races | N parallel orders on limited inventory ⇒ 0 double allocations; concurrent issuance ⇒ unique IDs |
| Chaos / partition | CAP behaviour | kill primary mid-order, drop network during sync, duplicate/out-of-order/late webhooks, chain/SMS/worker outages |
| Offline/sync | Edge | airplane mode flows, quota full, clock skew, device revoked, app version skew |
| Security/privacy | | RBAC matrix tests, webhook forgery, rate limits, PII scans (no Aadhaar, no PII in audit/chain), deletion workflow |
| Accessibility | | automated (axe) + manual screen-reader + low-end device + slow-3G profiles + usability test with agents |
| Performance | | allocation latency at 10k–100k eligible credits, sync burst, listing queries |
| Research | | simulation reproducibility (seeded), metric correctness against hand-computed examples |

## 6. Risk register (top items)

| Risk | Impact | Mitigation | Owner/When |
|---|---|---|---|
| Sync complexity underestimated | Schedule | SP-1 first; narrow event model; chaos tests early | Sprint 0–3 |
| PWA storage eviction on devices | Data loss | Persistent storage, quota alerts, wrapper fallback | SP-1 |
| MRV formula credibility | Credibility | Documented sources, versioning, conservative buffer, reviewer sign-off | SP-2 |
| Payout legal path unclear | Scope | Sandbox port (D8), legal spike | SP-3 |
| SMS DLT approval lag | Notifications | Start in Sprint 0; in-app fallback | SP-4 |
| Verifier availability | Throughput | Satellite-first, risk queue, partner commitments | Pre-launch |
| Agent fraud/collusion | Integrity | Cross-checks, sampling, geofence, agent scoring | Sampling S6.3 in Sprints 4–7; agent scoring S6.6 in Sprints 12–13 |
| Scope creep from deck's 8 layers | Schedule | Scope table in PRD §5; change control via manifest | Ongoing |
| Team capacity unknown | Plan | Measure velocity after sprint 2; cut stretch first | Sprint 2 |
| Unsold inventory | Farmer trust | Honest status, buyer pipeline, aging boost | Pre-launch |

## 7. Demo script (end of Phase 5)
1. Agent onboards a farmer offline, captures plot + proofs, reconnects and syncs. 2. Verifier approves; credits appear net of buffer; farmer SMS. 3. Two buyers race for limited inventory; FCAE splits fairly; one gets a shortfall. 4. Payment with delayed/duplicated webhook; order resolves correctly. 5. Ledger and sandbox payout; farmer statement. 6. Certificate + chain proof + audit-chain verification. 7. Dispute → freeze → reversal using buffer. 8. Research dashboard comparing FCAE with baselines.

## 8. Operating model after launch
On-call rota for payments/sync alerts; weekly invariant review; monthly restore test; quarterly methodology review; farmer-feedback loop via agents.
