# Demo buyer purchase slice: marketplace, reservation, simulated payment, fulfilment

Status: **Proposed, awaiting sign-off (2026-10-19). Nothing in this document is implemented.** Scope: the demo subset of [06 §4.2 and §6](06-technical-design.md), [09](09-pricing-invoicing-design.md) and [14](14-company-buyer-flow.md), under the delivery limits of [13](13-public-demo-plan.md). Where this slice is simpler than the production design, §10 lists the deviation and the trigger that removes it. Rigor tier: money-adjacent but synthetic (simulated payments, no real users); the production invariants for double-sale and duplicate callbacks still apply in full, because they are the point of the demonstration.

## 1. Goal and non-goals

**Goal.** A seeded buyer can browse available demo credits, request a quantity, see an explained allocation and a fixed price, pay through a simulated provider, and end with credits they own, a purchase record, and ledger rows that reconcile to the payment. Duplicate callbacks, late success, payment failure and reservation expiry all leave the system consistent.

**Non-goals (deferred, not stubbed):** payouts, earnings statements and farmer-facing views; the double-entry journal and reversal reserve (doc 11); invoices and tax (an explicit zero-tax demo rule is recorded on each order); retirement and certificates; disputes and freezing; real payment provider; company registration; multiple credit types; vintage and state filters.

## 2. Decisions this spec makes (override at sign-off)

| # | Decision | Reason |
|---|---|---|
| B1 | New role `buyer` (users CHECK widened by migration). A buyer belongs to one scenario and sees only that scenario's credits. | Existing roles are `agent` and `verifier`; buyer must be denied on every existing route (tested). |
| B2 | **Payee group = farmer case** (`capture_id` of the issuance batch). | The registry has no payee nomination yet; one batch per case already exists. |
| B3 | **Single credit type, flat price from an effective-dated price list** (`demo_price_list`, insert-only, price per credit in paise). No vintage/state keys. | Keeps the "effective-dated" requirement of doc 09 §4 without the full price-book. |
| B4 | Allocation is **FCAE v0**: the documented algorithm with every tier weight equal to 1 (no FRPS tiers exist yet). Cap `max(1, ⌊0.15·Q⌋)`, reservation quota `max(1, ⌊0.5·(a+r)⌋)`, waiting-days ordering, deterministic tie-break on group id. | Behaviour matches doc 06 §6 so the tier weight can be added later without changing the contract. |
| B5 | Concurrency control is **the scenario row lock** (`SELECT … FROM scenarios WHERE id=$1 FOR UPDATE`), the same device `beginUpload` uses, then order row, then credit rows in ascending id. | One type per scenario makes a per-type advisory lock equivalent and simpler; proven pattern in this codebase. |
| B6 | Aggregates are **recounted from `demo_credits`**, not maintained (`farmer_available`). | Demo scale (hundreds of credits); removes a drift class. Revisit at 10k+ credits. |
| B7 | Money is `bigint` paise; commission is `DEMO_COMMISSION_BPS` (default 500) snapshotted on the order and applied **per credit** with round-half-even (doc 09 §5). | Same rules as production. |
| B8 | Time comes from the database clock; every function takes an optional `asOf`, and tests move time by writing `expires_at`, as the worker tests already do. | No hidden global clock. |
| B9 | The payment provider is a **port** with a deterministic simulator. Its webhook goes through the same handler a real adapter would use and is **HMAC-signed** (`PAYMENT_WEBHOOK_SECRET`); the presenter's "simulate" controls call the simulator, which signs and posts exactly like a provider. | Demo plan §"Real behaviour": simulation must exercise the real handlers. |

## 3. Roles and visibility

| Actor | Can | Cannot |
|---|---|---|
| Buyer | list inventory summary; quote; create order; start/cancel a payment attempt; read **own** orders, purchases and receipts | see farmer label, village, plot, evidence, other buyers' orders, other scenarios; call agent/verifier routes |
| Agent / Verifier | unchanged | any buyer route (403) |
| Presenter (agent account) | trigger simulator outcomes for an order in its own scenario | affect orders of another scenario |
| Showcase (public) | read-only sample inventory counts | any write |

The marketplace shows **pseudonymous group labels** (`Group 07`), the credit count, vintage, price, and the provenance link (batch and calculation IDs). It never shows names, villages or exact areas. Order ownership is `orders.buyer_id` from the session, never from the request body.

## 4. State machines

**Credit** (existing guard from migration `0002`; no change): `AVAILABLE → RESERVED → SOLD`, and `RESERVED → AVAILABLE` on release. `SOLD → RETIRED` and `REVERSED` are out of scope here.

**Order**

```
CREATED ─allocate─► RESERVED ─attempt created─► AWAITING_PAYMENT ─attempt SUCCEEDED (owns credits)─► FULFILLED
   │ shortfall: buyer declines → CANCELLED        │ cancel / reservation lapses → EXPIRED / CANCELLED
   │                                              └─ SUCCEEDED but credits no longer owned ─► REVALIDATING ─all free─► FULFILLED
                                                                                         └─ otherwise ─► REFUND_PENDING ─► REFUNDED
```

`PAID` is not a separate persisted state in this slice: success and fulfilment commit in one transaction (the demo plan's "same transaction"), so an order is never PAID but not FULFILLED. Terminal states: `FULFILLED`, `CANCELLED`, `EXPIRED`, `REFUNDED`.

**Payment attempt:** `CREATED → PENDING → SUCCEEDED | FAILED | CANCELLED`. Several attempts per order are allowed while the reservation lives.

**Reservation clock:** `reserved_until = allocated_at + 5 min`; when the simulator confirms an attempt `PENDING`, extend to `max(current, now + 15 min)` capped at `allocated_at + 30 min` (doc 06 §4.2).

## 5. Data model (migration `0005_buyer_orders.sql`)

All tables carry `scenario_id` (FK to `demo_namespaces`) so isolation is a column filter, as elsewhere.

| Table | Purpose and key constraints |
|---|---|
| `demo_price_list` | `(scenario_id, effective_from)` PK, `unit_price_paise bigint CHECK > 0`, `created_by`. Insert-only (immutable trigger). Price in force = greatest `effective_from <= asOf`. No row → `PRICE_NOT_CONFIGURED`. |
| `demo_orders` | `id`, `scenario_id`, `buyer_id`, `request_id` (UNIQUE per scenario+buyer) + `request_hash`, `quantity` (1..100), `state` CHECK, `unit_price_paise`, `price_effective_from`, `commission_bps`, `principal_paise`, `tax_paise` (0, with `tax_rule` text `DEMO_ZERO`), `payable_paise`, `shortfall` + `shortfall_reason`, `reserved_until`, `allocated_at`, `version`, timestamps. CHECK: `payable_paise = principal_paise + tax_paise`; `principal_paise = unit_price_paise × quantity` once allocated. |
| `demo_order_items` | `order_id`, `credit_id` FK, `group_id` (capture), `active boolean`. **Partial UNIQUE `(credit_id) WHERE active`** is the database-level guarantee that no credit is held by two orders (P1). |
| `demo_allocation_log` | immutable: order, `as_of`, inputs (per-group available/reserved/waiting-days), weights, cap, quota, per-group result, binding shortfall reason (`SUPPLY`/`CAP`/`QUOTA`). Powers the buyer's "why these credits" view. |
| `demo_payment_attempts` | `id`, order, `provider_ref` UNIQUE, `state`, `amount_paise` (CHECK equals the order's `payable_paise` at creation, re-checked in the handler), `snapshot_hash`. |
| `demo_payment_events` | `provider_event_id` PRIMARY KEY (webhook idempotency), attempt, `type`, `payload_hash`, `received_at`, `outcome` (`APPLIED`, `IGNORED_DUPLICATE`, `IGNORED_TERMINAL`, `REFUND_QUEUED`). Insert-only. |
| `demo_payment_refunds` | `id`, order, attempt, `kind` (`LATE_UNFILLABLE`, `DUPLICATE`), `amount_paise`, `state` (`PENDING`, `REFUNDED`), UNIQUE `(attempt_id, kind)`. |
| `demo_ledger_entries` | append-only (immutable trigger): one row **per credit sold**: `order_id`, `credit_id` UNIQUE, `payee_group_id`, `gross_paise`, `commission_paise`, `net_paise`, CHECK `gross = commission + net`, all ≥ 0. UNIQUE on `credit_id` makes a double posting impossible. |
| `demo_group_state` | `(scenario_id, group_id)` PK, `last_allocated_at` — set **only on FULFILLED** (doc 06 step 7). |
| `demo_buyer_limits` | `(scenario_id, buyer_id)` PK, row locked first at order creation for the per-buyer limits. |

Also: `users.role` CHECK gains `'buyer'`; a trigger rejects a `demo_orders` state change that is not in the machine above (same style as `guard_demo_credit`).

## 6. Operations and API

All routes are under `/api/v1`, require a session, check CSRF on writes, and derive scenario and buyer from the session. Quantities and prices are never accepted from the client except `quantity` and `requestId`.

| Route | Behaviour |
|---|---|
| `GET /market/inventory` | Counts of AVAILABLE credits, price in force, per-group availability labels. Cacheable for a few seconds, `no-store` for private fields. |
| `POST /orders` `{requestId, quantity, quotedTotalPaise?}` | One transaction under the scenario lock: reap lapsed reservations, resolve price, run FCAE v0, reserve credits, write items, allocation log, snapshot, audit event. Returns the order, allocation explanation, `expiresAt`, and `priceChangedFromQuote`. A shortfall returns the partial allocation **un-reserved** with the binding reason; the buyer then calls accept or cancel (see below). Replaying the same `requestId` returns the stored result; reusing it with different input is `KEY_REUSE`. |
| `POST /orders/:id/accept-partial` | Reserves the offered partial set (re-checked under the lock; if it changed, returns a new shortfall). |
| `POST /orders/:id/payment-attempts` `{acceptSnapshotHash?}` | Verifies the order is `RESERVED`/`AWAITING_PAYMENT`, the buyer owns it, items are active, and the price snapshot is accepted if it changed. Creates the attempt; the simulator confirms `PENDING`, which extends the reservation. |
| `POST /orders/:id/cancel` | Releases credits, order `CANCELLED`. Refused once `FULFILLED`. |
| `GET /orders`, `GET /orders/:id` | Own orders only; includes items, allocation explanation, payment attempts, refund status, and ledger lines once fulfilled. |
| `POST /payments/webhooks/simulator` | **Unauthenticated by cookie, authenticated by HMAC signature and timestamp window.** Records the event first (idempotency by `provider_event_id`), then applies it. |
| `POST /demo/orders/:id/simulate` `{outcome: success\|failure\|duplicate\|late_success}` | Presenter-only. The simulator builds a signed provider event and posts it to the webhook handler in-process. `late_success` first advances the order past `reserved_until`. |

### 6.1 Success handler (the critical path)

Order of locks is fixed: scenario row → buyer-limits row (creation only) → order row → credit rows ascending id.

1. Verify HMAC and timestamp; insert `demo_payment_events` with `ON CONFLICT DO NOTHING`. If it already existed, return the stored outcome (`IGNORED_DUPLICATE`) with no side effect.
2. Take the scenario lock, then lock the order and its credits. Re-read everything **under the lock**.
3. If the order is `FULFILLED`, `REFUNDED` or `REFUND_PENDING`: record a `DUPLICATE` refund row for this attempt, order unchanged.
4. Ownership check: every credit is `RESERVED`, every item `active`, and each credit's active item belongs to **this order**. If yes: credits → `SOLD`, one ledger row per credit, `demo_group_state.last_allocated_at = now()` per group, order → `FULFILLED`, audit event, all in this transaction. The attempt's amount must equal `payable_paise`, otherwise nothing is applied and the event is flagged `AMOUNT_MISMATCH` for reconciliation.
5. Ownership check fails (expired, reaped, released): order → `REVALIDATING`; try to re-reserve **the same credits, all-or-nothing**. If every one is `AVAILABLE`: continue as step 4 (quota-exempt). Otherwise order → `REFUND_PENDING` and insert a `LATE_UNFILLABLE` refund. No partial fill after payment.
6. Non-success events (`FAILED`, `CANCELLED`) never change an order in a terminal state.

### 6.2 Reservation reaping

`reapExpired(db, asOf)` runs under the scenario lock at the start of every allocation and from the worker. It moves RESERVED credits whose active item's order passed `reserved_until` back to `AVAILABLE`, sets `active=false`, and moves the order to `EXPIRED` (unless an attempt is `PENDING`; then it asks the simulator for the attempt's status first, per doc 06 §4.2 "Sweeper"). The worker cycle gains a market sweep step with its own metrics (`greenchain_reservations_reaped_total`, `greenchain_orders_by_state`).

### 6.3 FCAE v0 (what is computed)

Inputs, read under the lock: per group `a_g` (AVAILABLE count), `r_g` (RESERVED count), `waiting_days_g = ⌊(asOf − max(last_allocated_at_g, oldest_available_at_g))/1 day⌋`. For each group `u_g = min(a_g, cap, room_g)`, `cap = max(1, ⌊0.15·Q⌋)`, `room_g = max(0, quota_g − r_g)`, `quota_g = max(1, ⌊0.5·(a_g+r_g)⌋)` (skipped when REVALIDATING). If `Σu_g < Q`, return a shortfall with the binding reason; the cap is never silently relaxed (no `cap_override` in this slice). Otherwise fill by descending `waiting_days_g` then ascending group id, one credit per round up to `u_g`, lowest credit id first within a group. The result is deterministic for stored inputs and is written to the allocation log. **Per-buyer limits:** at most 3 open orders and at most 10% of currently eligible supply reserved at once, counted under the buyer-limits row.

## 7. Failure modes

| Failure | Detection | Required behaviour | Test |
|---|---|---|---|
| Two buyers take the last credits at once | partial unique index; scenario lock | exactly one wins; the other gets a shortfall (`SUPPLY`), never an error 500 | race (pg) |
| Same `requestId` retried or sent twice concurrently | receipt unique key | one order, identical response; different body → `KEY_REUSE` | race (pg) |
| Webhook delivered twice, in parallel | `provider_event_id` PK | one fulfilment, one set of ledger rows | race (pg) |
| Two **different** success events for one attempt/order | order state check | second recorded as `DUPLICATE` refund; order unchanged | pglite + pg |
| Success arrives after expiry, credits still free | ownership check fails → REVALIDATING | same credits re-reserved, order FULFILLED | pglite |
| Success arrives after expiry, a credit was taken | REVALIDATING fails | `REFUND_PENDING` then `REFUNDED`; no credit sold | pglite + pg race (expiry vs payment) |
| Payment failure or buyer abandons | attempt `FAILED`; reservation lapses | credits released, order `EXPIRED`; retry allowed inside the reservation | pglite |
| Reservation expires while the success handler runs | lock order: whichever takes the scenario lock first wins; the other re-reads | consistent either way; never SOLD for an expired, re-reserved credit | race (pg) |
| Webhook with bad/missing signature or stale timestamp | HMAC check before any write | 401, nothing recorded as applied | pglite |
| Amount in event differs from `payable_paise` | handler check | no state change; event stored `AMOUNT_MISMATCH`; visible in metrics | pglite |
| Buyer reads or acts on another buyer's/scenario's order | ownership predicate | 404, never 403 (no existence leak) | pglite |
| Agent or verifier calls a buyer route; buyer calls agent routes | role check | 403 | pglite |
| Price list changes between quote and order | `quotedTotalPaise` mismatch | `priceChangedFromQuote=true`; a payment attempt requires `acceptSnapshotHash` | pglite |
| No price configured | resolve step | `PRICE_NOT_CONFIGURED`, whole transaction rolled back, nothing reserved | pglite |
| Database or worker down during payment | webhook returns 503, provider retries | event not recorded until applied; replay applies once | pglite |
| Sweeper crash mid-reap | single transaction | all-or-nothing; next sweep repeats | pglite |
| Integer overflow or float in money | type and CHECK | all money is `bigint`; test with large quantity × price | unit |

## 8. Invariants (scheduled checks and test oracles)

1. A credit is `SOLD` ⇔ it has exactly one ledger row and its order is `FULFILLED`.
2. A credit is `RESERVED` ⇔ it has exactly one active order item and its order is `RESERVED` or `AWAITING_PAYMENT`.
3. No reservation outlives `reserved_until` by more than one sweep interval.
4. For every `FULFILLED` order: `Σ gross = principal_paise = unit_price_paise × quantity` and `Σ commission + Σ net = Σ gross`; one `APPLIED` payment event with matching amount.
5. Every `REFUNDED` or `REFUND_PENDING` order has zero `SOLD` credits and a refund equal to the captured amount.
6. `demo_group_state.last_allocated_at` changed only for groups with a `FULFILLED` order.
7. The audit chain stays verified (`verifyAuditFull`) after any sequence of the above.

The oracle is a function `assertMarketInvariants(db)` used by every test and exposed as a worker check with a metric (`greenchain_market_invariant_violations`).

## 9. Security and privacy

- Buyer identity from session only; every query filters `scenario_id` and `buyer_id`. Tests cover IDOR on order IDs, attempt IDs and ledger lines.
- Webhook: constant-time HMAC compare, 5-minute timestamp window, body size limit, event stored by id before processing. The secret comes from `PAYMENT_WEBHOOK_SECRET` (required to enable the route; absent → route returns 404). It is never logged (already covered by logger redaction patterns; add `PAYMENT_WEBHOOK_SECRET` and `signature` to the redact list).
- No farmer PII reaches a buyer response. A test asserts the serialized buyer inventory and order payloads contain none of the fixture's label/village strings.
- Simulate endpoint exists only for scenarios present in `demo_namespaces`, and only for the `agent` presenter role; the production configuration flag `DEMO_MODE=false` removes it.
- Banner "Demonstration — synthetic credits and simulated payments" on every buyer screen and in every response `namespace: "DEMO_ONLY"`. No claim of real settlement or recognised credits.

## 10. Deviations from the production design

| Production (doc 06/09) | This slice | Trigger to remove the deviation |
|---|---|---|
| Per-credit-type advisory locks, order of six lock classes | Scenario row lock | A second credit type or throughput beyond one lock per scenario |
| Maintained `farmer_available` aggregate | Recount | ~10k credits per scenario or p95 allocation > 200 ms |
| Price book with state/vintage keys, tax rules, invoices | Flat effective-dated price, zero-tax marker | Invoicing slice |
| FRPS tier weights | Weight 1 | FRPS tiers exist |
| `cap_override` | Not available | Pilot with fewer than 7 groups needs it |
| Journal/lots/reserve in the same transaction | Per-credit ledger rows only | Payout slice (it will add the journal and read these rows) |
| Payee group nomination | Group = case | Payee nomination feature |

## 11. Test plan

**PGlite (logic, constraints):** price resolution and `PRICE_NOT_CONFIGURED`; FCAE v0 determinism (shuffled input), cap, quota, shortfall reasons, REVALIDATING quota exemption; every state transition, and illegal ones rejected by the trigger; webhook signature/timestamp; each failure row above; role matrix; PII-absence; money rounding and per-line half-even; `assertMarketInvariants` after every scenario; audit chain verified at the end.

**Real PostgreSQL (`npm run test:pg`), parallel connections:** last-credits race with N buyers; concurrent identical and conflicting `requestId`; duplicate and parallel webhooks; expiry racing payment success in both lock orders; concurrent reap and allocate; concurrent success events for one order. Each race gets a **mutation check** (remove the lock or unique index, watch the test fail) as for the existing suite.

**Smoke:** a script `scripts/demo-market-smoke.mjs` runs the 8–10 minute presentation path against a running local API and prints the invariant report.

## 12. Build sequence (each step ends with tests green and a commit)

1. **Migration 0005 and domain core:** tables, triggers, price resolution, FCAE v0 as a pure function with property tests. No HTTP.
2. **Order service:** create, accept-partial, cancel, reap; invariants function; PGlite tests; first pg races (last credit, requestId).
3. **Payment port, simulator and webhook handler:** success handler with all branches; duplicate, late, refund; pg races (duplicate webhook, expiry vs payment).
4. **HTTP routes, buyer role, seed** (20 groups × 10 credits, a buyer account, the price list), auth/IDOR tests.
5. **Worker sweep, metrics, invariant check;** README and docs 17/22 status.
6. **Web:** marketplace and quote, order detail with allocation explanation, payment status, presenter simulate panel, banner. Manual device checks stay deferred as before.

## 13. Open questions for sign-off

1. **B3 flat price vs price book.** Recommended: flat now (this spec). The alternative adds vintage/state keys and a publish workflow, roughly doubling step 1.
2. **Seed size.** Recommended: 20 groups × 10 credits, matching doc 13, created by a direct seed (the real issuance path yields one to two credits per case and would need 20 full capture-to-review runs).
3. **Commission rate.** Placeholder 5% (500 bps) from doc 09's worked example; confirm or give the demo value.
4. **Refund realism.** The simulated refund resolves immediately on the next simulator tick. Do you want a visible `REFUND_PENDING` interval in the demo?
5. **Buyer sign-in.** One seeded buyer account in the `presenter` scenario (recommended), or a separate buyer scenario so the presenter sees inventory only through the marketplace?
