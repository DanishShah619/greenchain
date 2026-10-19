# 12 · Payouts & KYC Penny-Drop — Design

Status: Draft v3 (APPROVED by Codex in iteration 2; non-blocking suggestions folded in) (design approved for documentation; **not yet implemented**) · Implements S2.3, S10.5, S10.6 (+ S10.8, S10.9) · Related: [06](06-technical-design.md) §3, §4.3, §8 · [10](10-architecture.md) §4, §8 · [11](11-reversal-reserve-design.md).

> **MVP uses sandbox adapters behind real ports (D8).** The legal/KYC path for real payouts is unresolved (SP-3: which entity may hold and disburse funds, the penny-drop provider and consent wording, TDS/TCS). All thresholds, limits, scores and durations are **[A]** placeholders.

---

## 1. Decisions and context
- **Component type:** two outbound integrations in the worker process. (a) A **daily batcher** turns RELEASABLE ledger lots into one payout per payee; a per-payout send job drives the rail state machine through `PayoutPort`. (b) **`KycPort` penny-drop:** a sync-ish initiate at nomination or payee change, then an async result job.
- **Decisions (from the user):**
  1. **Daily batch per payee with a minimum amount**; sub-threshold amounts roll over.
  2. Short **holdback** (default 7 days) only for first-time or Bronze-tier payees — a ledger lot state, consumed by the batcher (doc 11).
  3. **Recovery** up to 25% of each payout is applied by the batcher from `farmer_receivable` through the ledger port (doc 11).
  4. **Payee change** requires agent + farmer OTP + cool-off (default 48 h **[A]**); the first payout after a change is **flagged** (informational plus review-queue visibility, not a hold).
  5. Holdback and recovery are **active in sandbox/demo and gated in production** until legal sign-off (doc 11 §9).
- **Failure model:** an unknown outcome is never retried blind. **Concurrency:** payee lock, `SKIP LOCKED` job claim.
- The domain never imports a vendor SDK (10 §8).

## 2. Module boundaries

```
src/modules/payouts/   domain/ (stateMachine, amount, classify; pure)
                       application/ (runBatch, sendPayout, resolveIndeterminate, reconcile)
                       infra/ (repos, PayoutPort, adapters/sandbox)   http/
src/modules/identity/kyc/  domain/ (nameMatch, translit)  application/ (initiate, poll, review)
                       infra/ (KycPort, adapters/sandbox)
```
- **Reads:** `LedgerRead` (releasable lots with payee snapshot), `LedgerPayoutPort.openBatch` (recovery; ledger-owned), `PayeeRead` (identity view: verified account, cool-off, OTP).
- **Writes:** `payouts` writes only its own tables; recovery rows are posted by `ledger` inside the batcher transaction.

## 3. Data model

| Table | Key columns and constraints |
|---|---|
| `payout_batches` | `run_date` (IST), `run_id`, status; UNIQUE (run_date, run_id) |
| `payouts` (extends 06 §3) | batch_id, payee_id, `amount_paise` CHECK > 0, `recovery_paise` CHECK between 0 and 25% of gross, state, attempts, next_attempt_at, flags[], `account_ref` (FINANCIAL_REF token); UNIQUE (batch_id, payee_id). **The idempotency key sent to the rail is `payouts.id`** |
| `payout_items` | payout_id, `lot_entry_id`, `active`; partial UNIQUE (lot_entry_id) WHERE active |
| `payout_attempts` | payout_id, attempt_no, request_at, `outcome_at` NULL, provider_ref, raw_outcome (redacted), class; append-only |
| `payee_verifications` (identity) | payee_id, account_ref, provider_ref, status, name_returned (IDENTITY key), score, algo_version, `cool_off_until`, verified_by NULL, reason |
| `recon_runs` | run_date, kind (INTERNAL/RAIL), diff_paise, detail |

- **Lot state is owned by the ledger** (doc 11 §4–5): `payee_id`, `releasable_at` and the tier snapshot are set at FULFILLED; HELD → RELEASABLE is derived from `releasable_at`; there is no UPDATE of append-only rows and `settlement_state` becomes a view.
- **Invariants:** one payout per (batch, payee); a lot sits in at most one active payout; payout ≥ 0 and ≤ per-transaction limit; `Σ ledger payee net = Σ SETTLED + Σ in-flight + Σ recoveries + Σ unconsumed`.

## 4. Port contracts

| Call | Request | Response | Errors |
|---|---|---|---|
| `PayoutPort.send` | `{key, amount_paise, account(sealed), narration}` | `{status: ACCEPTED/SETTLED/REJECTED, rail_ref}` | TRANSIENT, UNKNOWN_OUTCOME, TERMINAL(BENEFICIARY_REJECTED/ACCOUNT_CLOSED), LIMIT, RAIL_DOWN |
| `PayoutPort.getByKey` | key | FOUND{status} / NOT_FOUND | TRANSIENT |
| `PayoutPort.statement` | date | items `{key, rail_ref, amount, status}` with `status ∈ SETTLED, PENDING, RETURNED, REJECTED` | TRANSIENT |
| `KycPort.initiate` | `{verification_id, account(sealed), ifsc}` | `{status: PENDING/VERIFIED/INVALID, provider_ref, name_returned?}` | TRANSIENT, PROVIDER_UNAVAILABLE, INVALID_INPUT, UNKNOWN_OUTCOME |
| `KycPort.getResult` | provider_ref | same as above | same as above |

## 5. Payout state machine (extends 06 §4.3)

| From | To | Trigger |
|---|---|---|
| PENDING / RETRY | IN_SETTLEMENT | claimed, attempt row written |
| IN_SETTLEMENT | SENT / SETTLED / FAILED / INDETERMINATE | accepted / settled synchronously / classified reject / unknown. A synchronous `REJECTED` is classified by reason: BENEFICIARY_REJECTED or ACCOUNT_CLOSED ⇒ FAILED (terminal); LIMIT, RAIL_DOWN or TRANSIENT ⇒ FAILED (retryable) |
| INDETERMINATE | SENT, SETTLED, FAILED, UNRESOLVED | status query by key; no answer after 24 h **[A]** ⇒ UNRESOLVED |
| UNRESOLVED | SENT / SETTLED / FAILED / CANCELLED | **only by evidence**: `getByKey` FOUND, a statement item, or **rail-confirmed absence** (`getByKey` NOT_FOUND after the rail's documented idempotency-retention window **and** the statements covering the dates show no item, approved by two people). Elapsed time or a manual judgement alone can never cancel. **Lots stay IN_BATCH while UNRESOLVED** |
| FAILED (retryable) | RETRY | backoff 1 min → 1 h with jitter, max 6 **[A]** |
| FAILED (terminal) | NEEDS_REVIEW | classification (rail rejected the transfer) |
| SENT | SETTLED / RETURNED | rail event or statement item with an explicit status (`SETTLED` ⇒ SETTLED; `RETURNED` or a `REJECTED` item after SENT ⇒ RETURNED; `PENDING` ⇒ stays SENT, age alert) |
| RETURNED | (terminal) | the original transfer is final and **cannot be retried**. Lots are released (RELEASABLE), the payee is flagged `REVERIFY_REQUIRED` and skipped by the batcher until re-verified; repayment happens only through a **new payout with a new key in a later batch** |
| NEEDS_REVIEW | CANCELLED / RETRY | finance decision, audited. `CANCELLED` requires **confirmed non-payment** (rail-rejected or rail-confirmed absence). `RETRY` re-sends with the same key and is allowed only while the rail has not accepted the transfer |

`CANCELLED` (confirmed non-payment) sets `payout_items.active = false`, returns the lots to RELEASABLE and posts the cancellation entries through the ledger (doc 11 E14). `RETURNED` (a transfer that had been sent and came back) releases the lots the same way, flags the payee for re-verification and is terminal. Payouts are never edited otherwise.

## 6. Batcher algorithm
1. Insert `payout_batches(run_date, run_id)` ON CONFLICT DO NOTHING. A COMPLETED batch → exit; RUNNING → resume.
2. List payees with RELEASABLE lots (`releasable_at <= asOf`, not ON_HOLD), sorted by id.
3. Per payee, one transaction:
   1. Take the payee lock (`payee_ledger_state` row, level 5 of the lock order).
   2. Require: verified account, past cool-off, OTP verified, not erased, not blocked, and **not flagged `REVERIFY_REQUIRED`** (a RETURNED payout invalidates the payee's verification until it is redone).
   3. Call `LedgerPayoutPort.openBatch(tx, payee, asOf)`: selects lots oldest-first up to the per-transaction limit, **tests the minimum on gross lots**, computes the recovery `R = min(⌊0.25·S⌋, receivable)` (0 when the legal gate is closed); **a single lot larger than the per-transaction limit is split by the ledger** (child lots as in doc 11): the part up to the limit is paid and the remainder stays RELEASABLE and returns `{lotIds, S, R, net}`.
   4. If `S < minimum` → nothing is written (rollover, a metric only). Otherwise insert payout + items (recovery rows were posted by the ledger).
4. Stop adding when the batch hits the rail's daily cap **[A]**; the rest roll over.
5. Mark the batch COMPLETED or PARTIAL.

**Worked example (PLACEHOLDERS: minimum 10,000 paise on gross lots, per-transaction limit 5,000,000, cap 25%):**

| Payee | Releasable S | Receivable | R | Payout | Result |
|---|---|---|---|---|---|
| A | 8,000 | 6,000 | – | – | rollover (S < 10,000); no recovery applied |
| B | 40,000 | 6,000 | 6,000 | 34,000 | PAYOUT 34,000 |
| C | 25,000 (`releasable_at` in 3 days) | 0 | – | – | excluded (HELD) |
| D | 80,000 | 0 | – | – | skipped, cool-off |
| E | 6,200,000 | 0 | 0 | 5,000,000 | lots up to the limit paid; the rest rolls over |

## 7. Failure modes

| Failure | Detect | Surface | Recover |
|---|---|---|---|
| Timeout / unknown outcome | `outcome_at` NULL, or transport error | state INDETERMINATE | Query the rail by key, never resend first. FOUND maps to SENT/SETTLED/FAILED. NOT_FOUND allows a resend with the same key **only while the rail's guaranteed idempotency window has not expired**; after it expires the payout stays UNRESOLVED until reconciliation confirms non-payment (L-6). After 24 h **[A]** unresolved → UNRESOLVED, with lots staying IN_BATCH until evidence arrives (never released by time alone) |
| Crash after attempt insert, before or after the call | attempt without outcome | same | Same rule: any attempt without an outcome is queried first |
| Duplicate payout | UNIQUE (batch, payee); partial UNIQUE on items; rail dedups on key | constraint error | No-op |
| Async failure after SENT | status poll or statement | RETURNED (terminal) | Payee flagged `REVERIFY_REQUIRED`; lots re-released; repayment only through a new payout (new key) after re-verification |
| Beneficiary rejected / account closed | classified TERMINAL | NEEDS_REVIEW; payee verification invalidated | Re-verify payee |
| Per-transaction / per-day limit | pre-check; rail code LIMIT | `LIMIT_DEFERRED` metric | Lots selected oldest-first up to the limit; remainder rolls over |
| Partial batch failure | per-payee transactions | batch PARTIAL | Re-run is a no-op for done payees |
| Wrong payee after SIM/account change | cool-off check | payout skipped `COOL_OFF` | Wait; first payout flagged `FIRST_AFTER_CHANGE` |
| Name mismatch (transliteration) | score below threshold | NEEDS_REVIEW queue | Human decision; never auto-reject (04 F1#3) |
| KYC provider outage | `PROVIDER_UNAVAILABLE`, breaker | verification PENDING_PROVIDER | Backoff retry; onboarding continues; payout blocked |
| `initiate` returns no `provider_ref` (timeout) | transport error | verification stays INITIATING | Retry `initiate` with the **same `verification_id`**; the adapter dedups and returns the existing verification (sandbox suffix 96 exercises this) |
| Farmer erased while pending | `SubjectErasureRequested` | audit | PENDING/RETRY → CANCELLED, lots released; in-flight states finish (FINANCIAL_REF is retained); residual balance is a legal item |
| Dispute opened on the plot | `DisputeOpened` | lots ON_HOLD | Excluded from batches until resolved (doc 11) |
| Reconciliation mismatch | recon job | page (diff ≠ 0) | Finance investigates; correction by reversal rows only |

## 8. Authorization
- **Principals:** `payout_worker` DB role (SELECT on ledger and identity views; INSERT/UPDATE on payouts, items, attempts only); `kyc_worker` (payee_verifications); `finance` (requeue, resolve); `verifier` (name review); `agent` (initiate); farmer (OTP).
- **Ledger writes from the worker:** `payout_worker` has EXECUTE only on `ledger.open_batch(...)`, `ledger.cancel_batch(...)` and `ledger.return_batch(...)` (the cancellation and return compensations, E14), a SECURITY DEFINER function owned by the ledger module that posts recovery/batch entries (E6/E12) and lot events atomically; it has INSERT on `payout_batches`, `payouts`, `payout_items` and on the job/outbox tables (to enqueue send jobs), and **no direct write on ledger tables**.
- **Enforcement:** DB grants plus an application guard; all human actions write audit rows in the same transaction.
- **Account decryption** happens only inside the send call (KMS, FINANCIAL_REF key class); never logged.
- **Payee change** requires an agent session, farmer OTP and the cool-off. A review override needs the `verifier` role, and a verifier cannot review a payee they onboarded **[A]**.

## 9. Idempotence and concurrency
- **Replay safety:** a batcher re-run, send retry or duplicate job consumes no lot twice and sends the same rail key.
- **Locks:** the payee lock is the `payee_ledger_state` row (level 5); a payout transaction takes only it, then rows in ascending id. Send jobs claim with `FOR UPDATE SKIP LOCKED` on `next_attempt_at <= now` in a capped `payout_send` queue.
- **Idempotency key:** required at the rail (`payouts.id`) and at KYC (`verification_id`).
- **Cross-store writes:** the attempt row is committed **before** the HTTP call, and the outcome is recorded after it. The send job is enqueued via the outbox in the batcher transaction.

## 10. Sandbox adapter specification
Deterministic by the last two digits of the account number, plus an in-process `SandboxControl` (`dropResponseAfterProcessing`, `failNext(n, kind)`, `advanceClock`). The adapter dedups on key and keeps its dedup history in a **persistent `sandbox_rail_state` table** (test schemas only), so worker restarts and crash-recovery tests do not lose the rail's memory; a separate `resetRail` control simulates a rail restart.

| Suffix | `PayoutPort` behaviour |
|---|---|
| 00 | ACCEPTED, SETTLED on next tick |
| 02 | timeout, not processed |
| 03 | timeout, **processed** (`getByKey` FOUND) |
| 04 | 5xx twice, then success |
| 05 | sync BENEFICIARY_REJECTED |
| 06 | SENT, then async RETURNED |
| 07 / 08 | per-transaction / per-day LIMIT |
| 10 | RAIL_DOWN |
| 12 / 13 | statement amount mismatch / missing item |

| Suffix | `KycPort` behaviour |
|---|---|
| 99 | VERIFIED, exact name |
| 98 | transliteration variant name |
| 97 | different name |
| 96 | timeout |
| 95 | outage |
| 94 | INVALID |
| 93 | PENDING, then result |

## 11. Payee verification and name matching
1. Agent nominates or changes the payee → farmer OTP → `initiate` (async job).
2. Match, then status VERIFIED, NEEDS_REVIEW or INVALID.
3. A **change** sets `cool_off_until = verified_at + 48 h` **[A]**; the initial verification has no cool-off.

**Matching:** NFKC; lowercase; strip honorifics (Shri, Smt, श्री, শ্রী) and punctuation. Deterministic Hindi/Bengali → Latin transliteration, then phonetic folding (v/w, sh/s, aa→a, ee→i, ph→f, doubled letters, Hindi schwa-deletion of a trailing "a"). Compare token sets, so order swaps and initials work. Score = max(Jaro-Winkler on the transliteration, normalised Levenshtein on phonetic keys), 0–100.

| Score **[A]** | Outcome |
|---|---|
| ≥ 85 | VERIFIED |
| 60–84 | NEEDS_REVIEW |
| < 60 | NEEDS_REVIEW, flagged `MISMATCH_LIKELY`, higher priority |

`algo_version` is stored so rescoring is reproducible. A name match never auto-rejects.

## 12. Reconciliation job (daily, after the batch)
- **INTERNAL:** the ledger/payout conservation equation per payee and in total; any diff pages.
- **RAIL:** `statement(date)` joined to payouts by key, with explicit status mapping: `SETTLED` ⇒ payout SETTLED (and ledger E13); `PENDING` ⇒ stays SENT with an age alert; `RETURNED`, or `REJECTED` after SENT ⇒ the RETURNED path. **Only an item or event with status SETTLED can set SETTLED**; a key/amount match alone never does. Missing at the rail after SENT > T, unknown key at the rail, or amount mismatch ⇒ NEEDS_REVIEW and page. Writes `recon_runs`.

## 13. API / admin surface

| Endpoint | Role |
|---|---|
| `POST /payees/:id/verification`, `POST /payee-verifications/:id/otp` | agent / farmer |
| `GET /kyc/review`, `POST /kyc/review/:id/decision` | verifier |
| `GET /finance/payouts`, `GET /finance/payouts/:id` (attempts) | finance |
| `POST /finance/payouts/:id/requeue`, `/cancel` (reason, idempotency key, audited) | finance |
| `POST /admin/payout-batches/run`, `GET /finance/reconciliation/payouts` | finance |

## 14. Observability
- **Logs:** `payout_id, batch_id, payee_pseudo_id, state_from/to, class, attempt_no, rail_ref, trace_id`; no account data.
- **Metrics:** payout lag (RELEASABLE → SETTLED p95); failure rate by class; NEEDS_REVIEW count and oldest age; rollover total; INDETERMINATE age; `recon_diff_paise` (must be 0); penny-drop failure and breaker rate.
- **Health:** last batch age, alert only if candidates exist. **Trace:** inbound from the outbox; outbound `traceparent` to adapters.

## 15. Test plan
- Table-driven state machine and illegal-transition tests.
- Property tests: no lot in two active payouts; payout ≥ 0; recovery ≤ 25%; the conservation equation.
- Fault injection through every sandbox suffix, plus crash points (between attempt insert and call, between call and outcome write).
- Two concurrent batchers; batcher versus recovery race; dispute opened mid-batch.
- Golden name corpus (~50 en/hi/bn pairs including mismatches).
- Erasure mid-flight; cool-off boundary; KYC outage with onboarding continuing; legal gate closed vs open.

## 16. Build sequence
1. Migrations, roles; lot `payee_id`/`releasable_at` and tier snapshot on the ledger (doc 11).
2. Pure domain: state machine, amount calculation, `nameMatch` with golden tests.
3. Ports and sandbox adapters with `SandboxControl`.
4. Payee verification and cool-off (S2.3).
5. Batcher with the ledger port.
6. Send job, classifier, INDETERMINATE resolver (S10.5).
7. Reconciliation job and metrics (S10.9).
8. Admin API and audit.
9. Fault-injection and race suite (S10.5 acceptance).

## 17. Open questions

| # | Question | Default meanwhile |
|---|---|---|
| P-1 | Is "first payout after a payee change" informational, or a hold? | Informational plus review-queue visibility |
| P-2 | Minimum payout threshold, per-transaction and daily limits, retry count, 85/60 score cut-offs, 48 h cool-off | The **[A]** values above |
| **Legal / rail (SP-3, do not block the sandbox)** | | |
| L-1 | Which entity may hold and disburse funds, and under what licence or permission | Sandbox only |
| L-2 | Licensed penny-drop provider; DPDP consent wording for bank verification; who bears the cost | Sandbox adapter |
| L-3 | TDS/TCS on payouts (T-2) changing the payable amount | Not modelled |
| L-4 | Enforceability and consent for the 25% recovery and 7-day holdback (Q-OQ-22) | Gate closed in production |
| L-5 | Treatment of an erased farmer's residual or unclaimed balance | Retained, flagged |
| L-6 | Real rail limits, statement format and cut-offs, bank name-return semantics | Unknown |
