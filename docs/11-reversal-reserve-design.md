# 11 · Reversal Reserve & Receivable Accounting — Design

Status: Draft v3 (revised after Codex review iterations 1-2) (design approved for documentation; **not yet implemented**) · Implements S7.6 and the ledger side of S7.4, S10.4, S10.5 · Related: [06](06-technical-design.md) §3, §4, §9 · [09](09-pricing-invoicing-design.md) · [10](10-architecture.md) · [12](12-payouts-kyc-design.md).

> **All amounts and rates are PLACEHOLDERS.** Holdback and recovery are **configuration behind a legal gate** (§9): they are active in sandbox/demo mode and inactive in production until a two-person approval records legal sign-off (SP-3, Q-OQ-22).

---

## 1. Decisions and context
- **Component type:** event-driven accounting workflow inside the `ledger` module (outbox consumers on the worker) plus one synchronous port used by `payouts`, and a reconciliation job. No HTTP hot path; correctness and auditability dominate.
- **Decisions (from the user):**
  1. Farmer **not at fault** ⇒ the platform absorbs the rupee loss from the reversal reserve.
  2. **Institution-confirmed fraud** ⇒ recovered only from the payee's future earnings, **capped at 25% of each payout** (configurable), never negative, visible on the farmer's statement.
  3. A fraudulent credit's **own unpaid lot is cancelled in full** (set-off); the cap applies only to recovery from *other* earnings.
  4. Opening a dispute **pauses the plot's HELD and RELEASABLE lots** (`ON_HOLD`).
  5. The reserve share funded from commission is **kept** when commission is credit-noted.
  6. A **short holdback** (default 7 days) applies only to first-time or Bronze-tier payees, as a ledger lot state (not a payout-delay hack).
  7. **No automatic write-off**; dormant receivables stay on the books. Manual write-off exists but is disabled by default.
  8. Manual movements require a second reviewer until a threshold is set (threshold effectively 0).
- **Scope:** rupees only. The buyer's *tonnes* are protected by the whole-tonne buffer pool (06 §4.1).
- **Recommended exposure window for sizing:** rolling 12 months of PAID lots (`reversal_window_days = 365` **[A]**, Q-OQ-23); to be re-checked against the observed loss rate after the pilot.

## 2. Module boundaries

```
src/modules/ledger/
  domain/  accounts.ts postings.ts (pure rules) reversal.ts (split, rounding) recovery.ts (cap plan) lots.ts money.ts
  application/ postEarning fundReserve handleReversal absorb recoverForBatch pauseLots writeOff manualMovement
  infra/   repos, outbox handlers, role grants     http/ finance + statement routes
  index.ts  LedgerPayoutPort.openBatch(tx, payee, asOf) ; events: LedgerReversalPosted, ReserveLow
```
- **Inbound:** `ReversalRequested{reversal_event_id, ledger_entry_id, gross_paise, fault_class, remedy}` from `disputes`/`registry` (and from `payments` for chargebacks); `DisputeOpened/Resolved{plot_id}`.
- `payouts ──► ledger` stays the only direction. `ledger` reads commission/tier snapshots through `OrderRead`. Money primitives (bigint paise, half-even) live in `kernel`, because `ledger` cannot import `pricing`.
- **ADR-013** (recorded in doc 10 §12): an additive **double-entry `journal`** is added beside `ledger_entries`. The earnings rows remain the feed for invoicing and statements; both are written in the same transaction.

## 3. Chart of accounts and posting rules

| Account | Type | Scope |
|---|---|---|
| `buyer_funds_clearing` | asset | global |
| `payee_payable` | liability | per payee group |
| `commission_revenue` | revenue | global |
| `reversal_reserve` | earmark (credit-normal) | global |
| `reversal_loss` | clearing/expense | global |
| `farmer_receivable` | asset | per payee group |
| `buyer_refund_clearing` | liability (settled by `payments`) | global |
| `payout_clearing` | liability (posted at batch) | global |
| `platform_capital` | equity | global |
| `platform_opex_loss` | expense | global |
| `buffer_replenishment_fund` | earmark (credit-normal) | global — receives money recovered or set off from farmers when a fraud reversal was remedied by a REPLACEMENT credit (no platform rupee loss); used to replenish the buffer pool |
| `bank_cash` | asset | global — bank side of payouts and refunds (settled by the rail reconciliation) |

Notation: line gross g = n + c; for a reversal of r paise, c_r is the commission part and n_r the net part.

| # | Event (idempotency key) | Debit | Credit |
|---|---|---|---|
| E1 | EARNED at FULFILLED (`EARN:{entry}`) | buyer_funds_clearing g | payee_payable[P] n; commission_revenue c |
| E2 | RESERVE_FUNDED (`FUND:{entry}`) | commission_revenue f | reversal_reserve f |
| E3 | REVERSAL, remedy REFUND (`REV:{evt}:1`) | commission_revenue c_r; reversal_loss n_r | buyer_refund_clearing r |
| E4a | FRAUD, remedy REFUND, uncovered part u = n_r − s: **loss-backed receivable** (`REV:{evt}:2`) | farmer_receivable u | reversal_loss u |
| E4b | FRAUD, set-off s against the entry's **unpaid** lot(s) (lot split, covered part CANCELLED; `REV:{evt}:3`) | payee_payable s | reversal_loss s (remedy REFUND) **or** buffer_replenishment_fund s (remedy REPLACEMENT) |
| E4m | FRAUD, remedy REPLACEMENT, uncovered part u: **memo claim only** — a `receivables` row with basis `MEMO_CLAIM`; no posting, because the platform made no cash outlay (`REV:{evt}:4`) | – | – |
| E5 | ABSORB, NO_FAULT + REFUND (`ABS:{evt}`) | reversal_reserve A | reversal_loss A |
| E6 | RECOVERY at batch, loss-backed receivable (`REC:{payout}:{rcv}`) | payee_payable ρ | farmer_receivable ρ |
| E6m | RECOVERY at batch, memo claim (`REC:{payout}:{rcv}`) | payee_payable ρ | buffer_replenishment_fund ρ |
| E7 | WRITE_OFF (`WO:{rcv}`; finance, disabled by default) | reversal_loss | farmer_receivable |
| E8 | RESERVE_TOPUP (manual) | platform_capital | reversal_reserve |
| E9 | OPEX_ABSORB of unfunded residual (manual) | platform_opex_loss | reversal_loss |
| E10a | RESCIND of the buyer-side refund: mirror of E3 with `reverses` set (`RES:{evt}:1a`) | buyer_refund_clearing r | commission_revenue c_r; reversal_loss n_r |
| E10b | RESCIND of an absorption: mirror of E5, posted **only if E5 absorbed part of the loss** (`RES:{evt}:1b`) | reversal_loss A | reversal_reserve A |
| E11 | RESCIND of a **fraud** reversal (`RES:{evt}:2`) — compensating postings for the E11 components (a)–(d) in the rules below | see components | see components |
| E12 | PAYOUT BATCH created (`PB:{payout}`) | payee_payable (S − R) | payout_clearing (S − R) |
| E13 | PAYOUT SETTLED (confirmed by the rail; `PS:{payout}`) | payout_clearing | bank_cash |
| E14 | PAYOUT CANCELLED / RETURNED with **confirmed non-payment** (`PC:{payout}`): reverses E12 and E6/E6m | payout_clearing (S − R); farmer_receivable ρ (loss-backed) or buffer_replenishment_fund ρ (memo claim) | payee_payable (S − R) + ρ |

Rules:
- `A = min(n_r, reserve balance)` computed under the reserve lock. Any residual stays as a debit balance on `reversal_loss` (the "unfunded" signal).
- **Remedy REPLACEMENT:** no cash moves to the buyer, so E3 and E5 are skipped. A no-fault reversal posts nothing beyond a zero-amount `reversal_cases` row. A **fraud** reversal records the recoverable amount as a **memo claim** (E4m) and moves any set-off/recovery into `buffer_replenishment_fund` (E4b, E6m). *Why no loss entry:* the platform kept the buyer's payment, delivered a valid credit from the buffer pool and paid the farmer; its cash position is unchanged, and the cost that was incurred is buffer *tonnes*, which the fund is meant to replenish. Recognising a receivable against a loss that never occurred would create an unmatched credit. The earnings-ledger row (`reverses` FK) is written with kind `REPLACED` for the farmer side; **invoicing issues a credit note only when the remedy is REFUND**.
- **No-fault never touches the farmer's lots**, so there is no timing lottery between paid and unpaid.
- **Fraud on a lot not yet paid** (E4b): the set-off `s = min(n_r, unpaid net of the entry's lots)` is taken from the entry's unpaid lot(s), oldest first. A partially covered lot is **split**: the covered part becomes a `CANCELLED` child lot and the remainder stays a child lot in the parent's state with the same `releasable_at`, so the farmer's unaffected earnings stay payable. Only the remainder `u = n_r − s` becomes a receivable or memo claim. The set-off is uncapped; the 25% cap applies only to recovery from *other* earnings.
- **E11 components** (each applied only when its amount > 0; the amounts come from `reversal_cases.setoff_paise`, `recovered_paise`, `outstanding_paise`): (a) *Outstanding claim* — `LOSS_BACKED`: Dr reversal_loss / Cr farmer_receivable for the outstanding amount; `MEMO_CLAIM`: the claim is closed with **no journal posting**. (b) *Set-off* — reinstate the cancelled amount as a new RELEASABLE lot (`origin = REINSTATED`): `LOSS_BACKED`: Dr reversal_loss s / Cr payee_payable s; `MEMO_CLAIM`: Dr buffer_replenishment_fund s / Cr payee_payable s. (c) *Recovered amounts* — refund as a new RELEASABLE lot (`origin = RECOVERY_REFUND`): `LOSS_BACKED`: Dr reversal_loss ρ / Cr payee_payable ρ; `MEMO_CLAIM`: Dr buffer_replenishment_fund ρ / Cr payee_payable ρ. (d) *Buyer side* — remedy REFUND: E10a (mirror of E3) and, only if absorption occurred, E10b (mirror of E5). Remedy REPLACEMENT: a delivered replacement credit cannot be recalled, so the rescind restores the **farmer side only** **[A]**, and replenishing the buffer tonnes consumed is handled under the fund policy (Q-OQ-26).
- **Reserve share is not clawed back** when commission is credit-noted (E2 stays).

**Worked example (PLACEHOLDERS: commission 500 bps, `reserve_bps` 2000, `cap_bps` 2500, reserve balance 150000):**
- Line 1: g = 100030, c = 5002, n = 95028 ⇒ f = half_even(5002 × 0.20) = 1000.4 → **1000**.
- Line 2: g = 100010, c = 5000, n = 95010 ⇒ f = **1000**.
- Case A, no-fault, REFUND, line 1 already paid: E3 (Dr commission_revenue 5002, Dr reversal_loss 95028, Cr buyer_refund 100030); E5 A = 95028 ⇒ reserve 150000 → 54972 and `reversal_loss` nets to 0.
- Case B, confirmed fraud, REFUND, line 2 paid: E3 and E4a net `reversal_loss` to 0; receivable 95010. Next batch gross P = 40000: cap = ⌊40000 × 0.25⌋ = 10000 ⇒ ρ = 10000, payout 30000, outstanding 85010. Following batch P = 2001: cap = ⌊500.25⌋ = 500, outstanding 84510.
- Case C, **partial fraud on an unpaid lot**: entry n = 95010, lot RELEASABLE; fraud reversal n_r = 40000, remedy REFUND. E3 posts as in Case A (with n_r = 40000). Set-off s = 40000 ⇒ the lot is split into a CANCELLED child (40000) and a RELEASABLE child (55010); E4b: Dr payee_payable 40000 / Cr reversal_loss 40000; u = 0, so no receivable. The farmer keeps 55010 payable; I2 holds (payable 55010 = Σ unpaid lots).
- Case D, **fraud with REPLACEMENT** on a paid entry: n_r = 95010. No E3. E4m records a memo claim of 95010 (no journal). Next batch gross S = 40000: ρ = 10000 ⇒ E6m: Dr payee_payable 10000 / Cr buffer_replenishment_fund 10000; payout 30000; claim outstanding 85010.
- Case E, **appeal succeeds on a REFUND fraud reversal** (one coherent case). Original: fraud reversal n_r = 135010, remedy REFUND. E3 posts the buyer-side loss of 135010 (plus commission). Set-off s = 40000 against an unpaid lot (split; E4b); uncovered u = 95010 becomes a loss-backed receivable (E4a); one batch later recovers ρ = 10000 (E6), leaving 85010 outstanding. Rescind (E11 + E10): (a) cancel outstanding 85010 (Dr reversal_loss / Cr farmer_receivable), (b) reinstate the 40000 lot (Dr reversal_loss / Cr payee_payable), (c) refund the 10000 recovered as a RELEASABLE lot (Dr reversal_loss / Cr payee_payable); components 85010 + 40000 + 10000 = **135010 = n_r**. E10a mirrors E3 (no E5 occurred, so no E10b). The farmer is made whole and `reversal_loss` nets to 0.
- Case F, **appeal succeeds on a REPLACEMENT fraud reversal** (same amounts). Original: n_r = 135010, remedy REPLACEMENT. No E3. Set-off s = 40000 (E4b: Dr payee_payable 40000 / Cr buffer_replenishment_fund 40000); uncovered 95010 is a memo claim (E4m, no posting); recovery ρ = 10000 (E6m: Dr payee_payable 10000 / Cr buffer_replenishment_fund 10000); outstanding 85010. Rescind: (a) close the memo claim — **no posting**; (b) Dr buffer_replenishment_fund 40000 / Cr payee_payable 40000 (reinstated lot); (c) Dr buffer_replenishment_fund 10000 / Cr payee_payable 10000 (refund lot). The fund nets to 0 (+40000 + 10000 − 40000 − 10000); no buyer-side posting.
- Exhaustion variant: reserve = 2000 ⇒ A = 2000, residual 93028 on `reversal_loss`, alert.

## 4. Data model (append-only; PKs UUIDv7; BIGINT paise)

- `journal_entries(id, seq IDENTITY, idempotency_key UNIQUE, kind, payload_hash, reverses_id FK, ledger_entry_id, reversal_event_id, actor, created_at)`
- `journal_lines(journal_id, line_no, account, payee_group_id, side, amount_paise CHECK > 0)` with `CHECK ((account IN ('payee_payable','farmer_receivable')) = (payee_group_id IS NOT NULL))` and a DEFERRED constraint trigger: Σdebit = Σcredit per journal.
- `lot_state_events(entry_id, seq, state, payout_id, at)` — PK (entry_id, seq); a trigger enforces legal transitions. **Supersedes the mutable `settlement_state` column** in 06 §3, which becomes a view over this table.
- `earning_lots(entry_id PK, parent_lot_id NULL, payee_group_id, net_paise, holdback_reason, releasable_at)` — `releasable_at` is set at FULFILLED (now for non-held payees, now + `holdback_days` for first-time/Bronze). A split creates child lots whose `net_paise` sum to the parent; the parent is closed by a `SPLIT` lot event. Lots created by reinstatement or recovery-refund (E11) carry `origin` = `REINSTATED` or `RECOVERY_REFUND`.
- `reversal_cases(reversal_event_id UNIQUE, ledger_entry_id, gross, c_r, n_r, fault_class, remedy, status POSTED|PARKED|REJECTED|RESCINDED, journal_id, setoff_paise, recovered_paise, outstanding_paise)` — the three amount columns are the components that a rescind must undo.
- `receivables(id, payee_group_id = credits.sold_payee_group_id, reversal_case_id UNIQUE, basis LOSS_BACKED|MEMO_CLAIM, principal_paise CHECK > 0)` — `LOSS_BACKED` claims are journalled (E4a/E6); `MEMO_CLAIM` claims are tracked only (E4m/E6m).
- `receivable_events(receivable_id, seq, kind, delta_paise, payout_id, journal_id)` — UNIQUE (receivable_id, payout_id) WHERE kind='RECOVERED'; deferred trigger: outstanding ≥ 0 and cumulative reversed gross per entry ≤ entry gross.
- `ledger_config(key, version, value, effective_from, created_by, approved_by CHECK distinct)` — keys: `reserve_bps`, `recovery_cap_bps` (2500; **CHECK between 0 and 5000**, so the payout floor `1 − cap_bps/10000` is at least 50% of the batch), `holdback_days` (7), `holdback_tiers` (Bronze), `auto_absorb_limit_paise`, `manual_threshold_paise` (0 until set), `reversal_window_days` (365 **[A]**), `writeoff_enabled` (false), `legal_gate_confirmed` (false in production).
- `payee_ledger_state(payee_group_id PK)` — a lock target only; holds no balances.
- **Roles:** `app_user` has INSERT/SELECT only; BEFORE UPDATE/DELETE triggers raise even for the owner role.

## 5. State machines

**Lot:**
```
HELD ─releasable_at job→ RELEASABLE ─batch→ IN_BATCH ─payout SENT→ PAID
HELD | RELEASABLE ─dispute opened→ ON_HOLD ─resolved→ (previous state)
HELD | RELEASABLE | ON_HOLD ─fraud confirmed (set-off, E4b)→ split: CANCELLED child (covered part) + remainder child in the parent's state
IN_BATCH ─PayoutCancelled→ RELEASABLE   (with a compensating E6)
```
- An entry starts HELD only when the payee has no PAID lot or the snapshot tier at FULFILLED is Bronze; otherwise it starts RELEASABLE. In production the HELD start is applied only when `legal_gate_confirmed` is true; otherwise every lot starts RELEASABLE.
- `ON_HOLD` lots are excluded from batches. A dispute closes the *paid-before-resolution* gap for unpaid lots; already PAID lots are handled by receivables.

**Receivable:**
```
OPEN → PARTIALLY_RECOVERED → RECOVERED (closed for recovery; a rescind may still refund recovered amounts)
OPEN | PARTIALLY_RECOVERED ⇄ SUSPENDED_APPEAL; successful appeal or chargeback won → CANCELLED via the E11 rescind (cancel outstanding, reinstate set-off lots, refund recovered amounts; see Case E)
OPEN | PARTIALLY_RECOVERED → DORMANT (payee erased, or no earnings for dormant_after_days)
DORMANT → WRITE_OFF_PENDING → WRITTEN_OFF (E7, then E5)    -- only when writeoff_enabled; off by default
```
`DORMANT` receivables simply remain on the books; nothing else happens automatically.

## 6. Recovery algorithm (inside `openBatch`, same transaction as the payout row)
1. Lock `payee_ledger_state` for the payee.
2. Select RELEASABLE lots by `releasable_at`, then `entry_id`. `S = Σ net`. **The minimum payout is tested on gross lots**: if `S < min_payout`, return empty (nothing is recovered, nothing is paid; the lots roll over).
3. Open receivables for the payee, excluding SUSPENDED/DORMANT, ordered by `created_at`, then `id`.
4. `cap = ⌊S × cap_bps / 10000⌋` (floored in paise, favouring the farmer); `R = min(cap, Σ outstanding)`. If `legal_gate_confirmed` is false in production, `R = 0`.
5. Allocate R across receivables FIFO, each taking `min(outstanding, remaining R)`; integers only, so no fractions arise.
6. Payout amount = `S − R`, which is at least `S × (1 − cap_bps/10000)` (≥ 50% of S given the config CHECK; 75% at the default 2500) and never negative. Post E6 or E6m per receivable (stamping `cap_bps` on the row), post E12 for `S − R`, write lot `IN_BATCH` events, and return `{lotIds, S, R, net}`. On rail confirmation the payouts module triggers E13.
7. A failed payout that retries keeps its amount; recovery is not re-run. A `PayoutCancelled` event posts a compensating E6 and returns lots to RELEASABLE.

## 7. Funding formula and sizing
- `f = round_half_even(c × reserve_bps / 10000)` per ledger line, written at FULFILLED with the `ledger_config` version id (the ledger copies it; fulfilment cannot fail on a missing config).
- **No statistics are asserted.** Sizing guidance: measure `λ` = absorbed paise ÷ gross GMV and `κ` = commission ÷ gross over the trailing window; require `reserve_bps ≥ 10000·λ·m/κ` for a safety multiplier `m` chosen by finance. If `λ·m > κ`, commission cannot self-fund and a `platform_capital` top-up (E8) is needed.
- **Exposure to watch:** the net of PAID lots inside `reversal_window_days` (default 365 **[A]**).
- **Pilot:** seed the reserve through E8 and start with a conservative `reserve_bps` chosen by the project owner **[A]**.

## 8. Failure modes

| Failure | Detect | Recover |
|---|---|---|
| Reserve exhausted | `A < n_r`; `reversal_loss` debit balance > 0 | Alert and finance escalation. **Never blocks a sale or payout.** Blocks only auto-absorb above `auto_absorb_limit` (needs finance approval); residual cleared by E9 |
| Reversal after farmer paid | lot PAID/IN_BATCH | No-fault: E3+E5. Fraud: receivable, recovered from future earnings |
| Reversal while batched or in flight | payout state under the payee lock | Never mutate the payout; treat the lot as paid; the next batch sees the open receivable |
| Duplicate reversal | UNIQUE `reversal_event_id` and journal key | No-op; same payload_hash returns the existing result, a different hash returns 409 `KEY_REUSE` |
| Out-of-order (entry missing, rescind first) | no `ledger_entries` row | PARKED, backoff up to 24 h **[A]**, then dead-letter and page |
| Over-reversal / partial | cumulative trigger | REJECTED; the last partial takes the remainder commission so Σ is exact |
| Payee changed after receivable | n/a | Receivable stays on `sold_payee_group_id`; not transferred to the new payee; ages to DORMANT |
| Farmer erased (DPDP) | `SubjectErasureRequested` | Rows kept (pseudonyms only); receivable DORMANT; no enforcement or notices; any write-off is a later finance decision (Q-OQ-9, Q-OQ-24) |
| Chargeback | `payments` event | NO_FAULT + REFUND unless the institution also confirms fraud (cumulative cap prevents double count); gateway fee is platform cost |
| Chargeback won | rescind event | E10 compensating rows |
| Payout cancelled after recovery | `PayoutCancelled` | Lots back to RELEASABLE, E6 mirrored, same transaction |
| Dispute opened while a lot is IN_BATCH | lot state under the payee lock | Lot stays in the batch (already moving); the dispute outcome is handled by receivable/absorb rules |
| Legal gate closed in production | `legal_gate_confirmed = false` | Holdback and recovery do not activate; lots start RELEASABLE and R = 0; visible on the finance dashboard |
| Partial fraud reversal (n_r smaller than the lot) | `n_r < lot net` | Lot is split; only the covered part is cancelled; remainder stays payable (Case C) |
| Fraud overturned after set-off and recovery | rescind event | E11 reinstates set-off lots, refunds recovered amounts, cancels outstanding claims, E10 mirrors the buyer side (Case E) |
| Fraud with REPLACEMENT on a paid entry | remedy = REPLACEMENT | Memo claim only; recoveries go to `buffer_replenishment_fund`; no loss entry (Case D) |
| Payout cancelled with confirmed non-payment | `PayoutCancelled` carrying a rail-confirmed-absent flag (doc 12) | E14 reverses E12/E6; lots return to RELEASABLE; a cancel without confirmation is rejected by doc 12's state machine |

## 9. Legal gate
Holdback (HELD lots) and recovery (R > 0) are **disabled in production until `legal_gate_confirmed` is set by a two-person `ledger_config` publication** that references the legal opinion. In sandbox/demo mode they are active so the full behaviour can be demonstrated and tested. This keeps the decisions the project owner made without silently deducting from or delaying real farmers' money before enforceability and consent are confirmed (Q-OQ-22, SP-3).

## 10. Authorization
- Automated postings: system role `ledger_worker` only.
- Manual movements (E7, E8, E9): `finance` role with a whitelisted `kind` that can never touch `payee_payable` directly. A **second reviewer is required for every manual movement until `manual_threshold_paise` is set** (CHECK `approved_by <> created_by`, as in doc 09).
- Config changes are two-person published.
- Statements: the farmer or their agent sees own `payee_group` lines (recovery amounts and credit IDs, no PII), enforced by an app guard on `payee_group_id`. SMS carries amounts only.

## 11. Idempotence and concurrency
- Every posting is keyed by its event id, so a double delivery is a no-op.
- **Lock order** (extends 06 §4.2's total order): (5) `payee_ledger_state` rows ascending by group id; (6) reserve advisory lock `pg_advisory_xact_lock(class_reserve, 0)`. Standalone ledger handlers never acquire earlier market locks. FULFILLED acquires the necessary payee/reserve locks after market locks and commits E1/E2, lots and reserve funding atomically with SOLD. Global reserve contention must be measured (doc 15). Anything needing both takes (5) before (6). Manual write-off sweeps lock payees ascending.
- Reserve balance is read as a SUM under (6); reserve-changing funding follows the same ordered lock protocol; do not rely on monotonicity to bypass the reviewed fulfilment contract.
- Cross-store effects go through the outbox (`LedgerReversalPosted`, `ReserveLow`).

## 12. Observability
- **Logs:** `reversal_event_id, journal_id, ledger_entry_id, payee_group_id, kind, fault_class, amount_paise, absorbed_paise, residual_paise, trace_id` at post/park/reject.
- **Metrics:** `reserve_balance_paise`, `reserve_burn_30d`, `reserve_cover_days`, `receivable_outstanding_paise{age}`, `recovery_rate`, `reversal_loss_unfunded_paise` (alert > 0), `parked_reversal_age`, `ledger_recon_diff_paise` (must be 0), `lots_on_hold`.
- **Reconciliation job (06 §11):** I1 Σdr = Σcr; I2 payable[P] = Σ net of HELD, RELEASABLE and ON_HOLD **leaf** lots (children after splits; parents counted once through their children) and ≥ 0; I3 receivable[P] = Σ outstanding; I4 reserve = funding + top-ups − absorbs ≥ 0; I5 Σ payouts = Σ lots − Σ recoveries; I6 reversed gross ≤ gross; I7 `buffer_replenishment_fund` = Σ E4b/E6m (REPLACEMENT) − rescinds ≥ 0; I8 `payout_clearing` = Σ E12 − Σ E13 − Σ E14.

## 13. API / admin surface

| Endpoint | Role |
|---|---|
| `GET /finance/reserve`, `GET /finance/receivables?age=` | finance |
| `POST /finance/reserve/topup`, `POST /finance/receivables/:id/write-off` (only when enabled), `POST /finance/reversals/:id/retry` | finance (+ second reviewer) |
| `POST /admin/ledger-config…` (two-person) | admin |
| `GET /farmers/:id/statement` (extends S10.6) | farmer/agent |

## 14. Test plan
- **Property tests (fast-check):** journal balanced under any event sequence; payable never negative across random interleavings of earn, reverse, hold, batch, recover, cancel; recovered ≤ ⌊cap⌋ per payout and outstanding ≥ 0; duplicated or shuffled delivery leaves invariants intact; partial reversals sum exactly to gross and commission; `r = c_r + n_r`.
- **Golden:** the worked example and .5 ties.
- **Added golden cases:** partial fraud on an unpaid lot (Case C), fraud with REPLACEMENT and recovery (Case D), successful appeal after partial recovery and set-off for both REFUND (Case E, components total n_r) and REPLACEMENT (Case F), a rescind after the receivable reached RECOVERED, payout cancel after recovery (E14), and a config CHECK rejection for `recovery_cap_bps > 5000`.
- **Failure injection:** crash between journal insert and outbox; two concurrent batchers; reversal during a batch; reserve exhaustion; payout cancel after recovery; erasure with an open receivable; payee re-key mid-recovery; dispute opened while lots are RELEASABLE vs IN_BATCH; legal gate closed vs open; UPDATE/DELETE and unbalanced journal rejected.

## 15. Build sequence
1. ADR-013 and migrations: accounts, journal, trigger guards, roles, `ledger_config`.
2. `money`, `postings`, `reversal` with golden and property tests (no DB).
3. E1/E2 at FULFILLED with dual-write reconciliation against `ledger_entries` (S10.4).
4. Lot events, holdback releaser job and `ON_HOLD` handling (S10.8, S7.7).
5. Reversal handler (E3–E5), parking and idempotency (S7.6 core, S7.4 hook).
6. `openBatch` with the recovery planner and legal gate (S10.5 integration, doc 12).
7. Top-up, DORMANT/erasure handler, appeal suspension; write-off behind its flag.
8. Reconciliation job, metrics, statement lines (S10.6).
9. Failure-injection suite.

## 16. Open questions
| # | Question | Default meanwhile |
|---|---|---|
| Q-OQ-22 | Legal sign-off for holdback and recovery (enforceability, farmer consent wording) | Gate closed in production |
| Q-OQ-23 | Reversal exposure window for reserve sizing | 365 days **[A]**; re-check after pilot |
| Q-OQ-24 | Policy for dormant/erased receivables (write-off vs enforcement) | No automatic write-off; flag off |
| Q-OQ-25 | Manual-movement second-reviewer threshold and `reserve_bps` seed value | Threshold 0 (always second reviewer); conservative `reserve_bps` chosen by the project owner |
| Q-OQ-26 | Where do recovered/set-off amounts in `buffer_replenishment_fund` go (buy tonnes to refill the buffer, or hold as reserve)? | Hold in the fund; policy decided by finance |
| (resolved) | The REPLACEMENT credit-note disagreement between 06 §9 and 09 §8 | Credit note only when remedy = REFUND; the farmer-side earnings row is written with kind `REPLACED` (see §3) |
