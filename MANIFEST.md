# GreenChain · Manifest

Last updated: 2026-10-14 · Version: docs v2 (draft) · Maintainer: project team

## Document index

| # | Document | Purpose | Status |
|---|---|---|---|
| – | [PRD.md](PRD.md) | One-page summary pointing to the docs below | Current |
| 01 | [docs/01-prd.md](docs/01-prd.md) | Product requirements, scope, metrics, acceptance criteria | Draft v2 |
| 02 | [docs/02-tech-stack-adrs.md](docs/02-tech-stack-adrs.md) | Stack and architecture decision records | Draft v1 (some **CONFIRM**) |
| 03 | [docs/03-user-flows.md](docs/03-user-flows.md) | End-to-end flows per persona incl. degraded network | Draft v1 |
| 04 | [docs/04-feature-flows-and-failure-modes.md](docs/04-feature-flows-and-failure-modes.md) | Per-feature failure tables (detect → recover) | Draft v1 |
| 05 | [docs/05-backlog-story-points.md](docs/05-backlog-story-points.md) | Epics, stories, points, dependencies, spikes | Draft v1 |
| 06 | [docs/06-technical-design.md](docs/06-technical-design.md) | Consistency model, data model, state machines, FCAE, sync, scale | Draft v1 |
| 07 | [docs/07-implementation-plan.md](docs/07-implementation-plan.md) | Phases, sprints, tests, risks, demo | Draft v2 |
| 08 | [docs/08-mrv-module-design.md](docs/08-mrv-module-design.md) | MRV methodology module: formula, confidence/buffer, data model, job lifecycle, tests (placeholder factors) | Draft v1 |
| 09 | [docs/09-pricing-invoicing-design.md](docs/09-pricing-invoicing-design.md) | Order pricing, price lists, invoices, credit notes, reconciliation (tax-agnostic; tax items need an accountant) | Draft v1 |
| 10 | [docs/10-architecture.md](docs/10-architecture.md) | Consolidated system architecture: context, containers, modules, flows, deployment, quality scenarios, extension points | Draft v1 |
| 11 | [docs/11-reversal-reserve-design.md](docs/11-reversal-reserve-design.md) | Reversal reserve, receivables, double-entry journal, holdback and dispute pause, legal gate | Draft v1 |
| 12 | [docs/12-payouts-kyc-design.md](docs/12-payouts-kyc-design.md) | Payout port, sandbox adapter, daily batcher, state machine, KYC penny-drop and name matching | Draft v1 |
| 13 | [docs/13-public-demo-plan.md](docs/13-public-demo-plan.md) | Public synthetic-data demo scope, sequencing and release checks | Draft v1 |
| 14 | [docs/features/README.md](docs/features/README.md) | Detailed specifications for F1–F17 and research evaluation; module contracts, security, scale and acceptance checks | Draft v1 |
| 15 | [docs/14-company-buyer-flow.md](docs/14-company-buyer-flow.md) | Company screen journey, checkout/recovery states, portfolio and retirement, security and demo acceptance | Draft v1 |
| 16 | [docs/15-system-design.md](docs/15-system-design.md) | Implementation baseline: ownership, invariants, transaction/lock protocol, durable jobs, capacity and recovery | Draft v1 |
| 17 | [docs/15-ml-workflow-design.md](docs/15-ml-workflow-design.md) | India-wide ML coverage strategy, evidence pipeline, ground truth, training/evaluation, advisory deployment and demo-to-pilot gates | Proposed design |
| 18 | [docs/research/west-bengal-research-protocol.md](docs/research/west-bengal-research-protocol.md) | West Bengal context/practice hypotheses, measurements, independent evaluation, specialist review and scientific release gates | Draft protocol |
| 19 | [docs/16-end-to-end-trace.md](docs/16-end-to-end-trace.md) | Joined application journey, module/data handoffs, buyer/farmer branches, exception paths and research/demo boundaries | Design trace |
| 20 | [data/ml/README.md](data/ml/README.md) | Collected West Bengal survey/emissions candidate data, provenance/licences, privacy filtering, quality report and replay scripts | Collected; audit gates open |
| 21 | [docs/17-mvp-progress.md](docs/17-mvp-progress.md) | First running MVP slice, checks and remaining delivery work | Foundation implemented |
| 22 | [docs/18-field-evidence-review.md](docs/18-field-evidence-review.md) | Boundary geometry, resumable proof uploads and separate evidence review | Demo slice implemented |
| 23 | [docs/19-demo-calculations.md](docs/19-demo-calculations.md) | Versioned synthetic scenarios, fixed-scale trace, immutable results and scope gates | Demo calculations implemented |
| 24 | [docs/20-demo-review-issuance.md](docs/20-demo-review-issuance.md) | Exact calculation basis, independent review and transactional demo credits/buffer/carry | Demo issuance implemented |

Application setup and local preview commands: [README.md](README.md).

Source material (unchanged): `GreenChain_PRD_Presentation_v1 (1).pptx`, `Danish_prakriti_final-1.pdf`, `GreenChain_Documentation (1).docx`.

Demo delivery: [docs/13-public-demo-plan.md](docs/13-public-demo-plan.md) defines the proposed synthetic-data public demonstration for the user's approximately 4–8 week window. It is separate from the production backlog and does not settle the outstanding scientific or legal questions.

## Locked decisions

Implementation clarification: the [feature design issues register](docs/features/design-issues.md) flags conflicts in older specifications, including D19's payout minimum terminology. New feature drafts use its explicit proposed resolutions; reconcile affected older rules before implementing them. Open accounting policy choices remain open.

| ID | Decision | Docs |
|---|---|---|
| D1 | CAP split: CP for credits/orders/payments/ledger/allocation; AP for field capture; stale reads labelled | 06 §2 |
| D2 | Agent-assisted primary channel; farmer via SMS/IVR | 03, 01 |
| D3 | Agent-signed records with device ID, captured-at, server received-at, clock-skew flag | 06 §5 |
| D4 | Modular monolith, single Indian region, designed for ~500K farmers | 02 ADR-001 |
| D5 | Land rights: owner or consented cultivator, institution-verified; one nominated payee; dispute freezes | 04 F2 |
| D6 | Verified-inventory marketplace; farmers paid on sale; unsold shown | 04 F8 |
| D7 | FCAE weighted (not filtered), per-farmer cap, deterministic | 06 §6 |
| D8 | Payout port, sandbox adapter in MVP | 02 ADR-007 |
| D9 | en/hi/bn, icon-first, voice prompts, 2 GB Android, WCAG 2.2 AA, SMS in MVP (IVR is stretch, S13.2; MVP fallbacks are agent tasks and human callbacks) | 02 ADR-010 |
| D10 | Buffer pool; reversal retires buffer and flags FRPS | 06 §7, §9 |
| D11 | No Aadhaar stored; phone + penny-drop + land record + institution attestation | 01 FR-ID-4 |
| D12 | Reservation tied to payment attempt (hard max); late success re-validates else refund; idempotent webhooks; outbox | 06 §4.2 |
| D13 | Drop Firestore; IndexedDB outbox + single sync API | 02 ADR-003 |
| D14 | Amoy, KMS minter, pseudonymous IDs, audit head-hash anchoring | 02 ADR-008 |
| D15 | Pluggable versioned MRV; cached Sentinel-2 NDVI for demo plots; confidence + buffer | 02 ADR-009 |
| D16 | Docs folder + manifest | – |
| D17 | Holdback (default 7 days, first-time/Bronze payees) and recovery (≤ 25% of each payout, never negative) are configuration behind a **legal gate**: active in sandbox, inactive in production until sign-off | 11 §9 |
| D18 | A dispute pauses the plot's unpaid lots (`ON_HOLD`); a fraudulent credit's own unpaid lot is cancelled in full | 11 §5 |
| D19 | Payouts: daily batch per payee, minimum tested on gross lots, rollover; reserve share kept on credit notes; no automatic write-off | 11, 12 |

## Proposed changes awaiting confirmation (deviate from deck/PDF)
- ADR-004 Postgres job queue/outbox replaces BullMQ/Redis queues; Redis is not used in the MVP.
- ADR-006 own OTP auth with server-side sessions instead of Firebase Auth/JWT (Firebase acceptable only for a synthetic-data prototype).
- One backend service (monolith + worker); Next.js is built as a static PWA with no API routes or SSR.
- TimescaleDB deferred (ADR-005).
- LTCC/TPC moved to fast-follow.

## Open-question register

| ID | Question | Default used meanwhile | Blocks |
|---|---|---|---|
| Q-OQ-1 | Buffer-pool % and bands by confidence | 10% base **[A]** | S5.3, S7.3 |
| Q-OQ-2 | Verifier review SLA | 7 days **[A]** | S6.1 |
| Q-OQ-3 | GST/TDS treatment on credit sales and commissions | Tax lines stored separately; no calculation | S10.1 invoicing |
| Q-OQ-4 | Refund/chargeback policy after fulfilment | Treat as reversal | S10.3, S7.4 |
| Q-OQ-5 | Who funds the reversal reserve (share of commission?) and buyer remedy if reversals exceed the buffer | Platform absorbs non-fault reversals from a reserve funded by a configurable commission share; confirmed fraud recovered from the payee's future earnings; beyond buffer ⇒ refund | S7.4, S7.6 |
| Q-OQ-6 | Price-setting rule (admin band vs bidding) | Admin price band | S9.1 |
| Q-OQ-7 | Agent incentives and anti-collusion model | Cross-checks + sampling | S6.3 |
| Q-OQ-8 | SMS/IVR vendor and DLT registration | Adapter + stub | S13.1 |
| Q-OQ-9 | Retention vs erasure per record class; whether any localisation rule applies beyond payment data | Crypto-shred what is erasable; retain encrypted statutory records; India hosting as a design choice | S2.5 |
| Q-OQ-10 | Team size/capacity/timeline | 2–3 devs, 30 pts/sprint **[A]** | Plan |
| Q-OQ-11 | Research scope vs product scope; target venue | DOCX plan | S14.* |
| Q-OQ-12 | Breach notification window and procedure | Legal review | S15.4 |
| Q-OQ-13 | FRPS: starting score, monthly caps, fault attribution | Start 0, caps **[A]** | S8.* |
| Q-OQ-14 | Methodology formula sources (IPCC tables, local factors) | SP-2 | S5.1 |
| Q-OQ-15 | Reservation timings (5 / 15 / 30 min), per-buyer limits (3 open orders, 10% of supply) and the per-group quota formula `max(1, ⌊0.5·(available+reserved)⌋)` | Values in technical design §4.2 **[A]** | S9.3, S9.4 |
| Q-OQ-16 | Allocation-group rule for the cap (verified payee account vs land-record holder) and FCAE parameters (B, H, G) | Payee account; B=100/125/150/200, H=30, G=3 | S9.2, S14.* |
| Q-OQ-17 | Buffer permanence period and release rules | 5 years **[A]**, admin release only | S7.3 |
| Q-OQ-18 | MRV factor sources, second reviewer, confidence weights/bands, M floor, factor period (doc 08 §13, M-1…M-6) | Placeholders | S5.1–S5.3 |
| Q-OQ-19 | Pricing product questions P-1…P-5 (doc 09 §14) | Single resolved price per key, no guardrail, invoice at FULFILLED | S9.1, S10.7 |
| Q-OQ-20 | Tax/legal questions T-1…T-9 (doc 09 §14): GST, TDS/TCS, document type and timing, inclusive vs exclusive price, numbering, credit notes, gateway fees, retention | Tax-agnostic structure; no tax computed until rules are published | S10.1, S10.7 |
| Q-OQ-21 | Credit volume per farmer-year used in capacity (5 t) and whether the MVP should enable the pilot-scale cap override | 5 t **[A]**; override audited and off | S9.2, S5.1 |
| Q-OQ-22 | Legal sign-off for holdback and recovery (enforceability, consent wording); the disbursing entity, penny-drop provider and TDS/TCS on payouts (SP-3; doc 12 §17 L-1…L-6) | Gate closed in production; sandbox only | S10.5, S10.8 |
| Q-OQ-23 | Reversal exposure window for reserve sizing | 365 days **[A]**; re-check after pilot | S7.6 |
| Q-OQ-24 | Dormant/erased receivables: write-off or enforcement | No automatic write-off; flag off | S7.6 |
| Q-OQ-25 | Manual-movement second-reviewer threshold and the seed `reserve_bps` | Threshold 0 (always second reviewer); conservative value chosen by the project owner | S7.6, S10.8 |

## Glossary
**FRPS** Farmer Reliability Point System · **FCAE** Fair Credit Allocation Engine · **MRV** Measurement, Reporting, Verification · **STCC/LTCC/TPC** short-term/long-term carbon credit, tree plantation credit · **COP** chain-of-provenance (unbroken FK chain from plot to purchase) · **KVK** Krishi Vigyan Kendra · **DPDP** Digital Personal Data Protection Act 2023 · **CCTS** Carbon Credit Trading Scheme · **BRSR** Business Responsibility and Sustainability Report · **Buffer pool** credits withheld at issuance to cover reversals · **Outbox** transactional queue written in the same DB transaction as the change.

## Change log
- 2026-10-19 (rev 10, Codex adversarial review of docs 11 and 12): doc 11 needed 3 iterations and doc 12 needed 2, both ending **APPROVED**. Doc 11: partial fraud reversals now split lots instead of cancelling whole lots; fraud with remedy REPLACEMENT is a memo claim whose recoveries/set-offs go to a new `buffer_replenishment_fund` (no unmatched loss entry); an E11 rescind undoes outstanding claims, set-offs and recovered amounts for both REFUND (Case E) and REPLACEMENT (Case F); payout batch/settle/cancel postings E12–E14 added; `recovery_cap_bps` bounded 0–5000; credit note only when remedy = REFUND; E10 split into E10a/E10b; new open question Q-OQ-26. Doc 12: payouts with an unknown outcome stay UNRESOLVED (lots stay IN_BATCH) and can be cancelled only on rail-confirmed non-payment; RETURNED is terminal with repayment via a new payout after re-verification (`REVERIFY_REQUIRED` blocks batching); only a statement item with status SETTLED can settle a payout; oversize lots are split; KYC initiate retries with the same `verification_id`; sandbox rail state is persistent; the worker reaches the ledger only through `open_batch`/`cancel_batch`/`return_batch`. Review artifacts: `.adversarial-review/msil-hmcx-pqwm` (doc 11) and `.adversarial-review/doc12-payouts` (doc 12).
- 2026-10-13 (training data collection): acquired published-source management and gas datasets; prepared 1,382 West Bengal survey records and 108 local rice-gas study records, plus overlapping India/global gas subsets. Removed identifier-bearing survey source files after allowlist export. Recorded licences, checksums, units/label limits and grouped-evaluation requirements; no model training or independent carbon validation performed.
- 2026-10-12 (West Bengal research): localised agricultural research to the user's selected state; added context matrix, evidence/access catalogue, data contract and explicit treatment/prediction/eligibility distinctions. Corrected the overstatement that NDVI proves practice adoption. Added executable synthetic formula-sensitivity analysis; no independent field validation or expert endorsement claimed.
- 2026-10-12 (system design): consolidated the implementation baseline in doc 15 with concrete transaction/lock order, active-basis lifecycle, at-least-once job/effect contracts, workload model, controlled scaling, and proposed RPO/RTO objectives and drills. Reconciled critical engineering conflicts in docs 06/08/10/11 and sync batch size. Replacement commission, live payout-minimum interpretation and scientific/legal gates remain open; capacity/recovery objectives are unmeasured.
- 2026-10-12 (ML workflow): added [docs/15-ml-workflow-design.md](docs/15-ml-workflow-design.md) for the confirmed demo-to-field-pilot scope and broad India coverage. Proposes shared data contracts with context-specific validation, evidence advisory tasks, grouped evaluation and isolated carbon research. National context priorities, accessible datasets and scientific release thresholds remain open; no model trained or existing methodology approved/replaced.
- 2026-10-12 (company journey): added detailed company buyer screen flow, navigation, module handoffs, payment recovery, document/portfolio distinctions and demo acceptance checks. Registration, company membership and planning targets are proposed additive design tasks; live onboarding and reporting rules remain open.
- 2026-10-11 (feature detail): added 18 feature specifications, [shared architecture/security contracts](docs/features/common-contracts.md), and an [implementation issues register](docs/features/design-issues.md). Documents cover ownership, ports, transactions, replay, resource authorisation, scaling and meaningful acceptance checks. API paths and limits are proposed; no application implementation or runtime validation is implied. Demo scope and backlog totals remain separate.
- 2026-10-11 (rev 9): added [docs/11-reversal-reserve-design.md](docs/11-reversal-reserve-design.md) and [docs/12-payouts-kyc-design.md](docs/12-payouts-kyc-design.md). Decisions D17–D19 (holdback/recovery behind a legal gate, dispute pause, daily batch). ADR-013 (additive double-entry journal) recorded in doc 10. Lock order extended with (5) `payee_ledger_state` and (6) reserve lock; `settlement_state` replaced by derived lot events; payout states INDETERMINATE/RETURNED/CANCELLED added (06 §4.3). Backlog 464 points / 453 MVP (new S7.7, S10.8, S10.9; S2.3 → 8, S7.6 → 8, S10.5 → 13); the plan is Sprint 0 plus 15–16 sprints and the cut list is required. New open questions Q-OQ-22…25.
- 2026-10-11 (rev 8, technical re-review fixes; part A 9 Major, part B 1 Critical + 9 Major): **06**: aggregate keyed by (group, type, state, vintage) with `reserved_count` and `available_since`; quota formula and distinct shortfall reasons (REVALIDATING exempt, cap override never lifts quota); per-buyer limits row first in the lock order; issuance and all payment-success handlers take the type lock; sweeper runs the reap routine; duplicate-success refunds as separate `payment_refunds`; one-sided clock drift and `UNVERIFIABLE`; classification order for revoked/deferred/rejected events and stored-status re-sends; no time tokens for revoked devices; waive/supersede as a verifier action before MRV and decision; audit `insert_seq`/`insert_mac` at insert time with chainer gap detection, horizon timeouts and a fenced lease; erasure journal with key generations and no subject-id reuse; `payload_hmac` under the subject key; keyed `plot_hash`; payee re-key transaction; `issuance_deltas`, basis revocations; partition-aware keys. **08**: decision carries `calc_id` under the cycle lock; revocation; `supersedes`-chain definition of latest; `inputs_hash` over resolved buckets and per-practice evidence flags; `POST_BASIS` flag; module views for `mrv_worker`; PUBLISHED-parameter-set trigger. **09**: commission and its tax snapshotted at allocation (`order_item_commission`) and copied by the ledger; two-sided tax coverage; priced-key filter; commit-time deferred margin trigger and emergency withdraw; credit-note idempotency; reconciliation includes commission tax and an awaiting-credit-note alert; column-level grants; per-line tax rounding. **10**: ledger reads commission snapshot via `OrderRead`; FRPS projection with sequence numbers and bootstrap; erasure by events; lease-row chainer; ownership of `issuance_basis*` and `issuance_deltas`. Backlog 440 points / 429 MVP (new S6.7; S2.4 → 8, S9.1 → 10, S9.7 → 8); plan is Sprint 0 plus 14–15 sprints and expects to use the cut list.
- 2026-10-11 (rev 7, technical review fixes; 5 Critical / 20 Major findings): **06**: one total lock order (advisory → order → credits → aggregates), ownership check on every PAID transition with takeover deactivating old items, duplicate-success handling, single credit type per order, reservation extension only on gateway-confirmed PENDING plus buyer/group quotas, aggregate keyed by payee group with reaping by the allocator, shortfall retry loop, chainer assigns its own `chain_seq` below the xmin horizon with row MACs and leader lock, per-class subject keys, `payload_hmac` instead of bare hashes, erasure journal replayed on every restore, honest time-integrity limits with session segments and `UNVERIFIABLE`, DEFERRED terminal outcome, device-signature auth for QUARANTINED with verifier review, per-slot media gating, BigInt arithmetic, whole-day waiting, cap-override. **08**: `issuance_basis` replaces `is_issuing` (written by the verifier decision), job key with input fingerprint, two-key advisory locks, publish-time parameter validation, content-addressed `ndvi_input_sets`, dedicated `mrv` queue with concurrency cap, canonicalisation spec, mrv no longer consumes verifier decisions. **09**: tax resolved and snapshotted at order time with publish-time tax-coverage validation, `effective_from` unique with commit margin and no retirement before the successor is effective, immutable entries, numbering existence-check and fixed series lock order, IST fiscal year, reversal-before-issue handling, reconciliation scoped to invoiced orders and tax-aware. **10**: dependency rules corrected (no `market → frps`, no pricing↔market cycle, `kernel`, `disputes`, ownership of tax rules, receivables and carry-over), DB roles on module views, extension claims narrowed with the real new pieces named, separate worker capacity. Backlog 429 points / 418 MVP (S2.5 → 13, S9.1 → 8, S9.4 → 5). New open question Q-OQ-21.
- 2026-10-11 (rev 6): added [docs/10-architecture.md](docs/10-architecture.md), the consolidated architecture (C4 context/containers/components, module dependency rules, runtime flows, deployment, quality-attribute scenarios, extension points for later layers). New ADR-011 (ports downward, events upward) and ADR-012 (API and worker as two process types from one codebase) are recorded there, not yet in 02.
- 2026-10-11 (rev 5): added [docs/09-pricing-invoicing-design.md](docs/09-pricing-invoicing-design.md). Decisions: admin-published effective-dated price list by credit type + vintage (no bidding); marketplace/agent invoicing model (farmer is supplier, platform invoices commission), tax treatment explicitly unconfirmed. `orders.price_paise_per_t` replaced by per-item prices and a snapshot; invoices triggered at `FULFILLED`. 06 §3 updated to point to doc 09. New open questions Q-OQ-18…20.
- 2026-10-11 (rev 4): added [docs/08-mrv-module-design.md](docs/08-mrv-module-design.md) from the backend-design workflow. Decisions: formula = practice-based factors × NDVI performance multiplier (NDVI is evidence, not a soil-carbon measurement); parameter sets live in versioned DB tables with second-reviewer publication. New tables `parameter_sets`, `methodology_versions`, `mrv_runs` and new `carbon_calculations` columns are specified there and not yet merged into 06 §3. F4#6 idempotency key updated. Open questions M-1…M-6 in doc 08 §13 (factor sources are the blocker; SP-2).
- 2026-10-11 (rev 3, boring-by-default review): server-side sessions replace JWT/refresh (easy device revocation, no stale role claims); Redis removed from the MVP (rate limits and OTP counters in Postgres); single audit chain with one chainer worker instead of 16 shards; Next.js built as a static PWA with a single backend service. Backlog now 419 points total / 408 MVP (S1.4 13 → 8). Kept on purpose, with cost noted: Polygon proof behind a port and fully async; custom outbox/sync (spike SP-1 first evaluates off-the-shelf sync libraries); per-subject keys for erasure; cached GEE exports. Docs 01–07 cite the 419/408 totals; earlier change-log entries keep the figures current at their time.
- 2026-10-09 (rev 2): adversarial review of docs v1 found 5 Critical / 13 Major issues; fixed in docs v2: single issuing calculation per cycle (no double issuance); REPLACEMENT credits and whole-tonne buffer; reversal after retirement and who bears the INR loss; in-flight order vs dispute rule; crypto-shredding erasure and random pseudonyms; revoked-device quarantine; signed-time-token clock rule; richer sync result codes (DEFERRED, KEY_REUSE, needs-fix list, media_complete gating); FCAE fixes (allocation group = payee account, integer arithmetic, aging from first inventory, `last_allocated_at` updated at PAID only, per-type advisory lock, maintained aggregate, small-order cap rule); order/payment-attempt state machines with lazy expiry and lock order; unchained audit inserts + chainer worker; `plot_code`; payee precedence; SMS/human-callback replaces IVR dependency in MVP; localisation reframed as a design choice; backlog +55 points (424 total, 413 MVP) with new stories S2.6, S4.5, S6.5, S6.6, S7.5, S7.6, S9.7, S10.7 and corrected dependencies; traceability table added.
- 2026-10-09: docs v1 created from deck, synopsis PDF and research DOCX after four rounds of design decisions (D1–D16). Supersedes PRD.md v1.1. Adversarial review of v1.1 (subagent) findings addressed: issuance trigger, order/payment contract, payout rail, reservation authority, webhook idempotency/outbox, Aadhaar/DPDP, wallet custody.
