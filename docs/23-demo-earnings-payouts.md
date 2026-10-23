# Demo earnings, journal, payouts and statement

Status: **Revision 2, signed off 2026-10-23. Build steps 1–2 of §12 are implemented (schema and guards, pure domain, earnings at fulfilment with database parity, demo clock); steps 3–6 are not.** Revision 2 folds in an independent design review; §14 lists what changed, §15 records decisions made while building. Scope: the demo subset of [11](11-reversal-reserve-design.md) (journal, lots, reserve funding) and [12](12-payouts-kyc-design.md) (batcher, payout state machine, sandbox rail), under [13](13-public-demo-plan.md): "simulated payout and statement", "payout simulation must resolve unknown outcomes by key before retrying", "statements expose gross, commission and net", "daily payout batching can use a protected demo clock". It builds on the buyer slice ([22](22-demo-buyer-purchase.md)), which writes one `demo_ledger_entries` row per credit sold. §10 lists every deviation from docs 11/12. Rigor: synthetic money, but the double-payout and conservation invariants apply in full.

## 1. Goal and non-goals

**Goal.** After a sale, each farmer group's earnings are posted to a balanced double-entry journal, held or released by the holdback rule, gathered into payouts by a batch, sent through a deterministic sandbox rail (timeouts, rejections, returns, late processing), and shown on an earnings statement (gross, commission, net, reserve share, payouts, balance). A presenter moves a protected demo clock so holdback and rollover are visible in minutes.

**Non-goals (deferred):** reversals, disputes, `ON_HOLD`, receivables and recovery (`recovery_paise` is always 0); real KYC, payee change and cool-off; TDS/TCS; a real rail and statement-file reconciliation; finance/verifier admin roles; SMS statements; lot splitting.

## 2. Decisions (override at sign-off)

| # | Decision | Reason |
|---|---|---|
| P1 | **Payee = farmer group = case** (`payee_group_id` = batch `capture_id`). Responses show an opaque HMAC label, never the id. | Key of `demo_ledger_entries`; ids are case ids and must not leak. |
| P2 | **Synthetic, pre-verified payees.** `demo_payees` holds a `SANDBOX-…NN` token (suffix selects rail behaviour) and `verified_at`; created on first earning with suffix `00`. No bank or identity data exists anywhere. | Doc 13: mock KYC, no real bank data. |
| P3 | **E1 EARNED and E2 RESERVE_FUNDED, the lot and its EARNED event are written in the fulfilment transaction** by `postEarnings`, called from `fulfil()` after the ledger rows. A database check makes this unavoidable (§5). Posting is a total function: zero-amount lines and zero-net lots are skipped, never allowed to fail a sale. | Doc 11 §11 atomicity, without letting an edge amount strand a captured payment. |
| P4 | **Configuration is data, per scenario**: `demo_ledger_config(scenario_id, version, holdback_days, reserve_bps, min_payout_paise, payout_limit_paise, backoff_base_seconds, idempotency_window_seconds, effective_from)`. Lots snapshot `holdback_days`, `reserve_bps` and the version; batches snapshot `min`/`limit`. Defaults: holdback 7 days, reserve 2000 bps, min ₹100, limit ₹50,000, backoff base 5 s, window 24 h. | Doc 11 §4 `ledger_config`; avoids reading `DEMO_MODE` in places that cannot see it; lets a presenter show rollover. |
| P5 | **Holdback only for demo scenarios** (the market is demo-scoped already; production config rows would set `holdback_days = 0` until legal sign-off). A payee with no **SETTLED** payout gets `releasable_at = earned_sim + holdback_days`, decided under the payee lock. | Doc 11 §9 legal gate; deterministic under concurrency. |
| P6 | **Two time domains, named.** Simulated time = `clock_timestamp() + demo_clock.offset` (`*_sim` columns): `earned_sim`, `releasable_at_sim`, `run_date`, `next_attempt_at_sim`, `first_request_sim`, the idempotency window and the 24 h rule. Real time (`*_real`): `lease_until_real` and worker polling. `simNow(tx, scenarioId) → {real, sim, offsetSeconds}`. | A clock jump must neither nullify holdback nor expire live leases. |
| P7 | **Demo clock** `demo_clock(scenario_id, offset_seconds 0..31,536,000)`, forward only (trigger), advanced by compare-and-set `{expectedOffsetSeconds, advanceSeconds ≤ 30 days}` (409 on mismatch, so a double-click cannot advance twice). | Doc 13; safe presenter control. |
| P8 | **Batches** per scenario, `run_date` = `(sim AT TIME ZONE 'Asia/Kolkata')::date`, `run_seq` (worker's scheduled run = 0, presenter runs = 1, 2, …), `UNIQUE(scenario_id, run_date, run_seq)`, `UNIQUE(scenario_id, request_id)`. One payout per payee per batch, oldest lots first up to the limit; a lot larger than the limit is skipped and flagged, later lots still go. Below the minimum: rollover. RUNNING/PARTIAL batches are resumed by the worker. | Several runs a day are needed (after a cancel, a release, a new sale). |
| P9 | **Sandbox rail** port with persistent memory (`demo_sandbox_rail`, keyed by payout id, stores the token/amount at first request and rejects a different token or amount for the same key). `send`, `getByKey → FOUND{status, amountPaise} \| NOT_FOUND`, `voidKey → VOIDED \| ALREADY_PROCESSED` (sandbox only), `idempotencyWindowSeconds`. Every call is logged for tests. Suffixes: 00 settles next tick; 02 timeout, not processed; 03 timeout, processed; 04 two transient failures then success; 05 beneficiary rejected; 06 sent then returned; 10 rail down; 11 timeout, processed N ticks later; 12 settles with a different amount. | Doc 12 §10; 11 and 12 make the late-processing and amount-check hazards testable. |
| P10 | **Payout state machine** (doc 12 §5): `PENDING → IN_SETTLEMENT → SENT → SETTLED`; retryable failure → `RETRY` (backoff in simulated time, base 5 s doubling, cap 1 h, jitter, **6 attempts total including resends**); terminal reject → `NEEDS_REVIEW` with `non_payment_confirmed`; unknown → `INDETERMINATE` → resolved by key; still unknown after 24 simulated hours **and** a fresh non-definitive `getByKey` → `UNRESOLVED`, which is still polled by key forever; `SENT → RETURNED`. `CANCELLED` only from `NEEDS_REVIEW`/`UNRESOLVED` with `non_payment_confirmed`. Lots become `PAID` at **SETTLED** (doc 11 says SENT; SETTLED is coherent here because RETURNED releases lots). | "Never retried blind"; nothing cancelled that may have been paid. |
| P11 | **Presenter** = an agent on an allow-list (`DEMO_PRESENTER_IDS`, default `presenter`), in a demo scenario other than `showcase`, with demo mode on. Shared guard `requirePresenter`, also applied to the existing buyer-slice simulator routes. | Today any agent could move the clock or cancel payouts. |
| P12 | **Statements**: only the agent who owns the case (`GET /cases/:id/statement`); verifiers are refused (doc 11 §10). The presenter's panel lists all payees by opaque label, including seeded groups without a review case. | Doc 11 §10. |

## 3. Roles

| Actor | Can | Cannot |
|---|---|---|
| Agent (case owner) | read own case's statement | read others'; change anything |
| Verifier, buyer, other agents | nothing new | statements, panel, controls (403/404) |
| Presenter (P11) | panel; advance clock (CAS); run batch; set a payee's sandbox suffix; cancel a confirmed-unpaid payout | edit amounts, lots, journal; move clock back; cancel anything not confirmed unpaid; act on another scenario or `showcase` |
| Worker | scheduled batch, resume, send, resolve, settle, invariants | — |

## 4. State machines

**Lot** (append-only `demo_lot_events`): `EARNED` (HELD/RELEASABLE derived from `releasable_at_sim` vs simulated now) `→ IN_BATCH → PAID` (payout SETTLED); `IN_BATCH → RELEASED` (payout CANCELLED/RETURNED) `→ IN_BATCH` again in a later batch. A lot held earlier stays held after the payee's first payout (`releasable_at_sim` is immutable).

**Payout**: P10, enforced by a transition trigger; `SETTLED`, `RETURNED`, `CANCELLED` final.

**Attempt**: append-only; at most one open attempt per payout (`outcome_at IS NULL`, unique index); `outcome_at`, `class`, `rail_ref` move from NULL to a value once (trigger). A resend closes the open attempt (`class = 'RESOLVED_ABSENT'`, only after `getByKey` NOT_FOUND) and opens a new one in the same transaction, committed **before** the rail call.

## 5. Data model (migration `0008_earnings_payouts.sql`)

| Table | Key constraints |
|---|---|
| `demo_ledger_config` | `(scenario_id, version)` PK; `reserve_bps 0..10000`, `holdback_days ≥ 0`, positive amounts; insert-only. |
| `demo_journal_entries` | `id`, `scenario_id`, `UNIQUE(id, scenario_id)`, `idempotency_key UNIQUE` (`EARN:`/`FUND:{ledger_id}`, `PB:`/`PS:`/`PC:{payout}`), `kind`, `payload_hash`, `line_count ≥ 2`, `total_paise > 0`, refs. Append-only. A repeated key with a different hash raises; same hash is a no-op. |
| `demo_journal_lines` | `journal_id, scenario_id, line_no`, `FK (journal_id, scenario_id)`, `account` enum (`buyer_funds_clearing`, `payee_payable`, `commission_revenue`, `reversal_reserve`, `payout_clearing`, `bank_cash`), `payee_group_id` with `CHECK ((account='payee_payable') = (payee_group_id IS NOT NULL))` and FK to payees, `side`, `amount_paise > 0`. Append-only. **Deferred constraint trigger on entries and lines: lines count = `line_count`, Σ DR = Σ CR = `total_paise`** (so zero-line journals and lines added later both fail). |
| `demo_payees` | `(scenario_id, payee_group_id)` PK, `account_token`, `verified_at`; token changes only by the presenter's suffix change (audited, with a history row). |
| `demo_payee_state` | same PK; the **payee lock** row; mutable `reverify_required`. |
| `demo_earning_lots` | `ledger_entry_id` PK (FK, one per ledger row), `scenario_id`, `payee_group_id`, `net_paise > 0`, `earned_sim`, `releasable_at_sim`, `holdback_days`, `reserve_bps`, `config_version`. Immutable. |
| `demo_lot_events` | `(ledger_entry_id, seq)` PK, `state`, `payout_id`, `at_sim`. Append-only; transition trigger. |
| `demo_clock` | `scenario_id` PK, `offset_seconds 0..31536000`, forward-only trigger. |
| `demo_payout_batches` | `id`, `scenario_id`, `run_date`, `run_seq`, `request_id`, `as_of_sim`, `as_of_real`, `min_payout_paise`, `payout_limit_paise`, `status`; `UNIQUE(scenario_id, run_date, run_seq)`, `UNIQUE(scenario_id, request_id)`. |
| `demo_payouts` | `id` (**rail key**), `batch_id`, `scenario_id`, `payee_group_id`, `account_token` (**snapshot, immutable**), `gross_paise`, `recovery_paise` CHECK = 0, `amount_paise > 0` immutable, `state`, `attempts`, `next_attempt_at_sim`, `first_request_sim`, `lease_until_real`, `non_payment_confirmed` (never reset), `flags`, `rail_ref`; `UNIQUE(batch_id, payee_group_id)`; `CHECK (NOT (non_payment_confirmed AND state IN ('SENT','SETTLED')))`; trigger: `CANCELLED ⇒ OLD.state IN (NEEDS_REVIEW, UNRESOLVED) AND non_payment_confirmed`. |
| `demo_payout_items` | `payout_id, ledger_entry_id, active`; **partial UNIQUE (ledger_entry_id) WHERE active**. `active` stays true for PAID lots; set false in the same function that releases lots. |
| `demo_payout_attempts` | `UNIQUE(payout_id, attempt_no)`; **UNIQUE (payout_id) WHERE outcome_at IS NULL**; set-once trigger. |
| `demo_sandbox_rail`, `demo_sandbox_calls` | rail memory and call log (test oracle; not read by app code except through the port). |

**Parity with the buyer slice:** `check_order_fulfilled()` (0005) is replaced to also require, per ledger row of the order, exactly one lot and one `EARN:` journal whose amounts match. This landed in migration `0009` with `postEarnings` (step 2) as a deferred check per ledger row rather than per order (§15). **Backfill**: 0008 creates payees, lots (`releasable_at_sim = earned_sim = created_at`, `holdback_days` 0, config version 0) and EARN/FUND journals for existing ledger rows, idempotently by journal key; payload hashes are built in SQL the same way as `payloadHash()` and a test compares them.

## 6. Operations

**Total lock order:** (1) scenarios row, (2) orders, (3) payment attempts, (4) credits, (5) `demo_payee_state` ascending, (6) `demo_payouts` row. Payout transactions take (5) then (6) and never (1)–(4); every writer of lot events, journals, payees or payee state holds (5). Claims select ids with `SKIP LOCKED` in a short transaction, then lock (5)→(6) and re-check. No lock is held across a rail call. Batcher, settle and cancel transactions use `SET LOCAL lock_timeout = '3s'`.

**6.1 Earnings at fulfilment.** `postEarnings(tx, {orderId, scenarioId, entries, clock})`: payee locks ascending; ensure payee and payee state; read config; holdback decision (no SETTLED payout → hold); E1 (Dr `buyer_funds_clearing` g / Cr `payee_payable[P]` n, `commission_revenue` c), E2 (Dr `commission_revenue` f / Cr `reversal_reserve` f, `f = half_even(c × reserve_bps / 10000)` using the existing BigInt helper), lot, EARNED event. Zero lines skipped; zero-net lot skipped.

**6.2 Batch.** Worker: when no `run_seq = 0` batch exists for the current simulated `run_date` (a database check, survives restarts), and resume RUNNING/PARTIAL. Presenter: `run_seq = max + 1` under a scenario advisory lock, replay by `request_id`. Per eligible payee (ascending), one transaction: lock (5); skip if `reverify_required`; select releasable lots oldest first within the limit (skip oversized, flag); below minimum → rollover metric; else payout (token snapshot) + items, E12 (Dr `payee_payable[P]` / Cr `payout_clearing`) = Σ item net, IN_BATCH events.

**6.3 Send, resolve, settle** (worker; capped per cycle; isolated so a rail outage never blocks audit/proofs; counted in the worker's idle flag).
- **Send** (`PENDING`/`RETRY` due by simulated time): lock (5)→(6), open attempt, `IN_SETTLEMENT`, `lease_until_real = now + deadline + 15 s`, set `first_request_sim` once; commit; call `send` with a deadline; record the outcome with `UPDATE … WHERE attempt_no = $n AND outcome_at IS NULL` (no-op if already resolved).
- **Resolve** (open attempt with `lease_until_real < now`, or `INDETERMINATE`, due): `getByKey` first. FOUND → its state (amount must match, else `NEEDS_REVIEW` flag `AMOUNT_MISMATCH`, no E13). NOT_FOUND within the window and under the attempt cap → close attempt, open a new one, resend with the same key and snapshot token. NOT_FOUND past the window → `non_payment_confirmed`, `NEEDS_REVIEW`. Unknown after 24 simulated hours with a fresh non-definitive query → `UNRESOLVED` (still polled).
- **Settle**: `settlePayout(tx, payoutId, sim)` is the only path for E13 (Dr `payout_clearing` / Cr `bank_cash`) and PAID events, used for synchronous and polled SETTLED. RETURNED → E14 (reverse E12), items inactive, lots RELEASED, `reverify_required`. A terminal reject also sets `reverify_required`; the presenter's suffix change clears it.
- **Cancel** (presenter, `requestId`, key `PC:{payout}`): check eligibility; call `voidKey` outside any transaction (idempotent); then lock (5)→(6), re-check, E14, items inactive, lots RELEASED. If `voidKey` says ALREADY_PROCESSED, the payout moves to SENT/SETTLED instead.

**6.4 API**

| Route | Behaviour |
|---|---|
| `GET /api/v1/cases/:id/statement` | owning agent only; earnings lines (credit id, gross, commission, net, reserve share), lots (state derived from simulated now, `releasable_at_sim`), payouts (state, amount), payable balance; no order/buyer ids, rail refs or tokens. |
| `GET /api/v1/demo/payouts` | presenter: payees by label with balances, batches, payouts, clock, config. |
| `POST /api/v1/demo/clock` `{expectedOffsetSeconds, advanceSeconds}` | presenter: CAS, forward only. |
| `POST /api/v1/demo/payouts/batch` `{requestId}` | presenter: new run for the current simulated day; replay-safe. |
| `POST /api/v1/demo/payees/:label/sandbox` `{suffix}` | presenter: allowed suffixes only; clears `reverify_required`; affects future payouts only. |
| `POST /api/v1/demo/payouts/:id/cancel` `{requestId, reason}` | presenter: confirmed non-payment only, else 409 `PAYOUT_MAY_BE_PAID`. |
| `PUT /api/v1/demo/ledger-config` | presenter: new config version (e.g. raise the minimum to show rollover). |

## 7. Failure modes

| Failure | Required behaviour | Test |
|---|---|---|
| Sender stalled mid-call, resolver runs | resolver waits for the real-time lease; one send | pg race + mutation (no lease ⇒ two sends) |
| Two batches / scheduled + presenter runs | one payout per payee per batch; no lot twice | pg race |
| Batch vs fulfilment for the same payee | lot in this batch or the next, never both or neither | pg race + mutation (no payee lock) |
| Concurrent send claims | each payout sent once | pg race + mutation (no SKIP LOCKED) |
| Crash after claim, before call / after call, before outcome / during resend / after void, before cancel | resolved by key; never blind | PGlite crash points |
| 02 timeout not processed | resends with the same key, ≤ 6 attempts, then `NEEDS_REVIEW` | PGlite |
| 03 timeout processed; 11 processed late | no second transfer; cancel refused before the window, voids after | PGlite |
| 04 / 10 transient | backoff in simulated time, success or `NEEDS_REVIEW` | PGlite |
| 05 rejected | `NEEDS_REVIEW`, confirmed unpaid, payee re-verify; next batch skips the payee | PGlite |
| 06 returned | E14, lots released, re-verify, repaid only by a new payout later | PGlite |
| 12 amount differs | `NEEDS_REVIEW`, no E13 | PGlite |
| Suffix changed mid-retry | payout keeps its token snapshot; rail rejects a changed token per key | PGlite |
| Clock jump of 30 days | holdback still measured in simulated time; live leases unaffected; FOUND payouts settle, not UNRESOLVED | PGlite |
| Sale after a clock jump | held for `holdback_days` of simulated time | PGlite |
| IST date boundary (18:30 UTC) | correct `run_date` | PGlite |
| 0 / 10000 bps commission, tiny commission | sale succeeds; zero lines skipped | PGlite |
| Ledger rows without the port; journal unbalanced, empty, edited, cross-scenario | commit fails | PGlite |
| Existing sold orders before 0008 | backfilled; parity holds | PGlite |
| Invariants while batches commit | no false positives (snapshot) | pg |
| Unauthorised presenter / verifier statement / other scenario / showcase | 403/404 | PGlite |

## 8. Invariants (scheduled, one snapshot: `REPEATABLE READ READ ONLY`, scoped by scenario, codes added to `INVARIANT_CODES`)

1. Every journal balances and matches its declared `line_count`/`total_paise`.
2. `payee_payable[P]` = Σ net of P's lots whose latest event is `EARNED` or `RELEASED`, and ≥ 0.
3. Each ledger row has exactly one lot and one `EARN:` journal with matching amounts.
4. Each live payout (not CANCELLED/RETURNED): gross = Σ net of its active items; lot `IN_BATCH` ⇒ payout live; lot `PAID` ⇔ payout SETTLED; lot `RELEASED` with a payout ⇒ payout CANCELLED/RETURNED.
5. `payout_clearing` = Σ E12 − Σ E13 − Σ E14 = Σ amount of payouts not SETTLED/RETURNED/CANCELLED.
6. Each E2 = `half_even(c × lot.reserve_bps / 10000)` (recomputed), and `reversal_reserve` = Σ E2.
7. Conservation per payee: Σ ledger net = payable + Σ amount of non-CANCELLED/RETURNED payouts.
8. `buyer_funds_clearing` debit = Σ gross of ledger rows.

Test-only oracle: each SETTLED payout has exactly one processed transfer at the sandbox rail; a CANCELLED payout has none.

## 9. Security, privacy, observability
- No bank or identity data; a test asserts responses contain no capture labels, villages, ids or account-like numbers (keys-only snapshot).
- All presenter actions audited (seed groups anchor to their seed capture); writes require CSRF.
- Logs: payout id, batch id, payee label, state from/to, class, attempt; never the token beyond its suffix.
- Metrics: payouts by state, `NEEDS_REVIEW`/`UNRESOLVED`/`INDETERMINATE` counts and oldest age, SENT age, rollover total, payout lag, `payout_clearing_paise`, reserve balance, ledger invariant violations, last batch age (health only when candidates exist).

## 10. Deviations from docs 11 and 12

| Production design | This slice | Removed by |
|---|---|---|
| KYC penny-drop, name match, payee change with OTP/cool-off | Pre-verified synthetic payees; presenter suffix | Identity/KYC slice |
| Receivables, 25% recovery, reversals, ON_HOLD, lot split | None (`recovery_paise` = 0; oversized lots skipped) | Disputes/reversal slice |
| `finance` role, two-person approvals, write-off | Allow-listed presenter, demo only | Finance admin slice |
| Rail statement reconciliation | Query by key; sandbox call log as test oracle | Real rail adapter |
| SECURITY DEFINER ledger functions, `payout_worker` role | Application discipline + DB guards | Production roles |
| Send-job outbox | State scan with `SKIP LOCKED` | Real queue need |
| Lot PAID at SENT | PAID at SETTLED | — (deliberate) |
| Tier holdback (Bronze) | First-time payee | FRPS tiers |
| No buyer-cash posting | `buyer_funds_clearing` only accumulates; `bank_cash` only pays out | Payments ledger slice |

## 11. Test plan
PGlite for logic, constraints, crash points, every suffix (00, 02, 03, 04, 05, 06, 10, 11, 12), golden postings (doc 11 lines 100030/100010 plus half-even ties at 1250 and 5000 bps), clock behaviour, backfill and parity, authorization and privacy, invariants after each scenario, audit chain. Real PostgreSQL for the races in §7, each mutation-checked. Live smoke with API and worker: sell, advance past holdback, batch, settle, statement reconciles; logs read for errors and secrets.

## 12. Build sequence (each step green and committed)
1. **Done.** Migration 0008 (tables, guards, backfill), config, pure domain (postings, state machine, backoff helpers extracted to the kernel) with constraint and golden tests.
2. **Done.** `postEarnings` from `fulfil()`, migration 0009 (parity check), payees, clock, `simNow`.
3. Batcher; pg races.
4. Sandbox rail and its tables (`demo_sandbox_rail`, `demo_sandbox_calls`), send/resolve/settle/cancel, crash points; pg races.
5. Routes, `requirePresenter` (also on the existing simulator routes), worker wiring, metrics, invariants.
6. Web: statement on the agent's case view; presenter payout panel.

## 13. Open questions (defaults apply unless changed)
1. Synthetic pre-verified payees, real KYC deferred (P2).
2. Holdback 7 days for first-time payees in demo scenarios (P5).
3. Reserve 20% of commission, minimum ₹100, limit ₹50,000, backoff base 5 s, window 24 h (P4), all changeable per scenario.
4. Presenter allow-list `DEMO_PRESENTER_IDS=presenter`, applied to existing simulator routes too (P11).
5. Verifiers do not see statements (P12).

## 14. What revision 2 changed (from the design review)
Critical: a resolver could resend while a sender was still in flight (real-time lease, one open attempt per payout, set-once outcome); cancel relied on NOT_FOUND alone, so a late-processing rail could pay twice (idempotency window, `non_payment_confirmed`, `voidKey`, suffix 11); the demo clock mixed time domains (holdback was nullified after a jump; named `*_sim`/`*_real` columns); daily-batch uniqueness blocked legitimate runs and `requestId` was not stored (`run_seq`, `request_id`, resume); payee state was mutable while payouts did not snapshot the token, and a rejected payee looped (token snapshot, `reverify_required` on reject). High/medium: complete lock order with timeouts; journal trigger covered neither empty journals nor later lines; zero-amount postings could fail a sale; invariants 4 and 6 were wrong or vacuous, conservation was missing, the scheduled check was not a snapshot; no backfill or DB-level parity with existing ledger rows; any agent could act as presenter and verifiers could see statements; the INDETERMINATE loop had no cap; the rail's amount was not checked; config could not be read where needed (now per-scenario data).

## 15. Decisions made while building
Step 1 (2026-10-23):
- The parity check moved from 0008 to 0009, and the sandbox rail tables to build step 4. Each lands with the code that needs it.
- A payout with `non_payment_confirmed` can never become `SENT` or `SETTLED`. This is enforced in both the domain table and the database, and it matches the `CHECK` in §5.
- `voidKey` returning VOIDED is what confirms non-payment before a cancel. ALREADY_PROCESSED leaves the flag unset.
- Database guards added beyond §5:
  - Each journal kind may only use its own accounts and sides (E1, E2, E12, E13, E14).
  - The idempotency key is derived from the kind and the reference (a `CHECK`).
  - `RESERVE_FUNDED` records its `basis_bps`, so invariant 6 can recompute zero-net sales that have no lot.
  - A lot must copy its ledger row's payee and net.
  - `releasable_at_sim` is either `earned_sim` or `earned_sim + holdback_days`.
  - A lot event must agree with the payout it names: `IN_BATCH` needs an active item, `PAID` needs `SETTLED`, `RELEASED` needs `CANCELLED`/`RETURNED`. Payout rows are therefore updated before the lot events that follow from them.
  - Items are added only while the payout is `PENDING`, only for the payout's own payee, and released only with a cancelled or returned payout.
  - A payout's token must be the payee's current token when the payout is built.
  - Attempts are numbered from 1 without gaps.
  - The batch `run_date` must equal the IST date of `as_of_sim`.
  - Only the 2-character suffix of a payee token can change, and every change writes `demo_payee_token_history` from a trigger.
- Attempt outcome classes: `ACCEPTED`, `SETTLED`, `TRANSIENT`, `REJECTED`, `RESOLVED_ABSENT`, `RESOLVED_FOUND`. Step 4 may extend the set with a migration.

Step 2 (2026-10-23):
- Parity is a deferred constraint trigger on each new `demo_ledger_entries` row, not a rewrite of `check_order_fulfilled()`. It also catches a row added later to an order that is already fulfilled. At commit the row needs:
  - its order `FULFILLED`, with matching row count and gross;
  - an `EARN:` journal whose hash equals the expected E1 for the row;
  - a lot, with its EARNED event, exactly when net is positive;
  - a `FUND:` journal equal to `half_even(c × basis)`, present exactly when the lot's reserve share is positive, with basis equal to the lot's `reserve_bps`.
- `check_journal()` now also recomputes each journal's payload hash from its lines (`journal_payload_hash()`). A stored hash is therefore always a faithful fingerprint, and parity can compare hashes.
- Order of work in `postEarnings`, after the credits (lock order step 5):
  1. Create any missing payees.
  2. Lock the payees in ascending order.
  3. Read simulated time and the configuration in force at that simulated time. A version whose `effective_from` lies in the simulated future is not yet used.
  4. Write journals and lots set-based (a few statements per sale, not per credit).
  It is a no-op when replayed.
- `postJournals` is idempotent by key. The same hash is skipped; a different hash, or another scenario, is refused with `JOURNAL_KEY_CONFLICT`.
- `advanceClock` runs under the scenario lock, so a sale never sees the clock move mid-fulfilment. Errors:
  - `VALIDATION_FAILED` (422): a step that is not 1 s–30 days;
  - `CLOCK_CONFLICT` (409): stale `expectedOffsetSeconds`;
  - `CLOCK_LIMIT` (409): beyond one year.
- Not yet covered: the payee lock against a concurrent batch is proven only by the step 3 pg race (§7, "Batch vs fulfilment").
