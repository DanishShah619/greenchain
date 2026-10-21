# Demo buyer purchase slice: marketplace, reservation, simulated payment, fulfilment

Status: **Revision 2, approved 2026-10-19. Build steps 1-2 are implemented: schema and guards (`0005`, `0006`), FCAE v0 and money (`modules/market/domain`), the order service (`modules/market/application`: scenario lock, create, accept-partial, cancel, reaper, invariants) payments (`payments.ts`: start attempt, signed webhook handler with every §6.1 branch, refund settlement; `infrastructure/simulator.ts`), the HTTP routes, buyer account and demo seed (`market/http/routes.ts`, `application/seed.ts`, `inventory.ts`), the worker sweep with market metrics and the scheduled invariant check (`application/sweep.ts`, `metrics.ts`), each with PGlite tests and real-Postgres races, and the web screens (`apps/web/src/BuyerWorkspace.tsx`, `PresenterMarketPanel.tsx`, `market.ts`). All six build steps are implemented. Manual checks on real phones remain deferred.** Revision 2 folds in an independent design review (`backend-design:component-architect`) that found defects in revision 1; §14 lists them. Scope: the demo subset of [06 §4.2 and §6](06-technical-design.md), [09](09-pricing-invoicing-design.md) and [14](14-company-buyer-flow.md), under the delivery limits of [13](13-public-demo-plan.md). Where this slice is simpler than the production design, §10 lists the deviation and the trigger that removes it. Rigor tier: money-adjacent but synthetic (simulated payments, no real users); the production invariants for double-sale and duplicate callbacks still apply in full, because they are the point of the demonstration.

## 1. Goal and non-goals

**Goal.** A seeded buyer can browse available demo credits, request a quantity, see an explained allocation and a fixed price, pay through a simulated provider, and end with credits they own, a purchase record, and ledger rows that reconcile to the payment. Duplicate callbacks, late success, payment failure and reservation expiry all leave the system consistent.

**Non-goals (deferred, not stubbed):** payouts, earnings statements and farmer-facing views; the double-entry journal and reversal reserve (doc 11); invoices and tax (an explicit zero-tax demo rule is recorded on each order); retirement and certificates; disputes and freezing; real payment provider; company registration; multiple credit types; vintage and state filters.

## 2. Decisions this spec makes

Confirmed by the user on 2026-10-19: **B10, B11, B12**. The others are proposals; override at sign-off.

| # | Decision | Reason |
|---|---|---|
| B1 | New role `buyer` (users CHECK widened by migration). A buyer belongs to one scenario and sees only that scenario's credits. | Existing roles are `agent` and `verifier`; buyer must be denied on every existing route (tested). |
| B2 | **Payee group = farmer case** (`capture_id` of the issuance batch). | The registry has no payee nomination yet; one batch per case already exists. |
| B3 | **Single credit type, flat price from an effective-dated price list** (`demo_price_list`, insert-only, price per credit in paise). | Keeps the "effective-dated" requirement of doc 09 §4 without the full price-book. |
| B4 | Allocation is **FCAE v0**: the documented algorithm with every tier weight equal to 1. Cap `max(1, ⌊0.15·Q⌋)`, quota `max(1, ⌊0.5·(a+r)⌋)`, waiting-days ordering, deterministic tie-break. | Same contract as doc 06 §6, so the tier weight can be added later. |
| B5 | Concurrency control is **one scenario row lock** taken through a single helper `withScenarioLock`; raw `FOR UPDATE` on market tables is not allowed outside it. Lock order everywhere: scenario row → order rows ascending id → payment-attempt rows → credit rows ascending id. | Same device as `beginUpload`; one helper makes the order impossible to get wrong. |
| B6 | Aggregates are **recounted from `demo_credits`**, not maintained. | Demo scale; removes a drift class. |
| B7 | Money is `bigint` paise. Commission (`DEMO_COMMISSION_BPS`, default 500, snapshotted on the order) is computed **in TypeScript BigInt, per credit, round-half-even**. | Postgres `round` is half-away-from-zero; doc 09 §5 requires half-even. |
| B8 | `asOf` is `clock_timestamp()` read **once, after the scenario lock is acquired**, and passed down. Tests move time by writing `expires_at`/`reserved_until`. | `now()` is the transaction start, which is stale after a lock wait. |
| B9 | The payment provider is a **port** with a deterministic simulator. Its events go through the same `handlePaymentEvent` a real adapter would use, HMAC-signed. | Demo plan §"Real behaviour". |
| B10 | **Late success after a buyer cancel fulfils the order** (via REVALIDATING, all-or-nothing on the same credits), because the payment is real. If the credits are gone, refund. | User decision. |
| B11 | **The per-buyer limit stays**: at most 3 open orders and at most 10% of *eligible supply* (AVAILABLE + RESERVED credits at order time), and at least 1, reserved at once (the "at least 1" floor matches the cap and quota rules, so a tiny pilot market is not locked out). Over the limit is a distinct `422 BUYER_LIMIT`, not a shortfall reason. With the 200-credit seed the effective maximum order is about 20; the seed and docs say so. | User decision. |
| B12 | **Audit anchor:** market audit events attach to a case. Order and payment events use the capture of the batch of the order's first credit (lowest credit id) as `capture_id`; the entity is named in the payload (`order:<id>`). System actors (webhook, reaper) use actor id `system:market` with scenario from the order. No schema change to `audit_events`. | User decision. |

## 3. Roles and visibility

| Actor | Can | Cannot |
|---|---|---|
| Buyer | list inventory summary; create order; accept a partial fill; start/cancel a payment attempt or order; read **own** orders and ledger lines | see farmer label, village, plot, evidence, other buyers' orders, other scenarios; call agent/verifier routes |
| Agent / Verifier | unchanged | any buyer route (403) |
| Presenter (agent account) | trigger simulator outcomes for orders in its own scenario | affect orders of another scenario |
| Showcase (public) | read-only sample inventory counts | any write |

The marketplace shows **pseudonymous group labels** (`Group 07`), counts, vintage, price and provenance (batch and calculation IDs); never names, villages or areas. Order ownership is `orders.buyer_id` from the session. Other buyers' or scenarios' ids return **404**, never 403.

## 4. State machines

**Credit** (guard from `0002`, extended in `0005`): `AVAILABLE → RESERVED → SOLD`, `RESERVED → AVAILABLE`. `0005` replaces `guard_demo_credit` (`CREATE OR REPLACE`, existing body kept) so that moving to `SOLD` requires the owning order to be `RESERVED`, `AWAITING_PAYMENT` or `REVALIDATING`. `RETIRED`/`REVERSED` stay out of scope.

**Order**

```
CREATED ──allocate OK──► RESERVED ──attempt created──► AWAITING_PAYMENT ──success, ownership intact──► FULFILLED
   │ shortfall                │ cancel / lapse                 │ cancel / lapse
   │ (no reservation)         ▼                                ▼
   ▼                    CANCELLED / EXPIRED ──late success──► REVALIDATING ──all same credits free──► FULFILLED
CANCELLED (buyer or sweep after 15 min)                                   └──otherwise──► REFUND_PENDING ──► REFUNDED
```

Allowed transitions, enforced by a trigger: `CREATED→RESERVED|CANCELLED`, `RESERVED→AWAITING_PAYMENT|CANCELLED|EXPIRED|FULFILLED|REVALIDATING`, `AWAITING_PAYMENT→RESERVED|CANCELLED|EXPIRED|FULFILLED|REVALIDATING`, `EXPIRED|CANCELLED→REVALIDATING`, `REVALIDATING→FULFILLED|REFUND_PENDING`, `REFUND_PENDING→REFUNDED`. `FULFILLED` and `REFUNDED` have no exits. "Terminal for the buyer" means no buyer-driven exit; only a payment success can move `EXPIRED`/`CANCELLED`. `PAID` is not persisted: success and fulfilment commit together. `CREATED` is a shortfall holding state; it is excluded from "open orders" and swept to `CANCELLED` after 15 minutes. Attempts can only be created on `RESERVED`/`AWAITING_PAYMENT`, so success on a `CREATED` order is unreachable (asserted).

**Payment attempt:** `CREATED → PENDING → SUCCEEDED | FAILED | CANCELLED`. `SUCCEEDED` is **absorbing** (trigger). `FAILED`/`CANCELLED` events apply only from `CREATED`/`PENDING`; but a success event may still move `FAILED`/`CANCELLED` to `SUCCEEDED`, because the money is captured. Events are never ordered by provider timestamp. After a failed attempt the order stays `AWAITING_PAYMENT`; the reaper expires it when `reserved_until` passes.

**Reservation clock:** `reserved_until = asOf + 5 min` at allocation; when the simulator confirms an attempt `PENDING`, extend to `max(current, asOf + 15 min)` capped at `allocated_at + 30 min`, through a locked path. At the cap the reaper expires the order even with a `PENDING` attempt; a later success is a late success.

## 5. Data model (migration `0005_buyer_orders.sql`)

All tables carry `scenario_id` (FK to `demo_namespaces`). Changes to existing tables: `users.role` gains `'buyer'`; `demo_credits` gains `available_since timestamptz NOT NULL DEFAULT now()` (set at insert, never updated; backfilled from the batch's creation time) and `reserved_order_id uuid REFERENCES demo_orders(id)` with `CHECK ((state IN ('RESERVED','SOLD')) = (reserved_order_id IS NOT NULL))` and the extended guard.

| Table | Purpose and key constraints |
|---|---|
| `demo_price_list` | `(scenario_id, effective_from)` PK, `unit_price_paise bigint CHECK > 0`, `created_by`. Insert-only. Price in force = greatest `effective_from <= asOf`. |
| `demo_orders` | `id`, `scenario_id`, `buyer_id`, `request_id`, `request_hash`, **UNIQUE `(scenario_id, buyer_id, request_id)`**, `quantity` (1..100, what the buyer asked), `allocated_quantity`, `state`, `unit_price_paise`, `price_effective_from`, `commission_bps`, `principal_paise`, `tax_paise` (0, `tax_rule='DEMO_ZERO'`), `payable_paise`, `shortfall_reason`, `reserved_until`, `allocated_at`, `version`, timestamps. CHECKs: `principal_paise = unit_price_paise × allocated_quantity`; `payable_paise = principal_paise + tax_paise`; `allocated_quantity ≤ quantity`. |
| `demo_order_items` | `order_id`, `credit_id`, `group_id`, `generation int`, `active boolean`. **Partial UNIQUE `(credit_id) WHERE active`** and **partial UNIQUE `(order_id, credit_id) WHERE active`**. `active` means *held or sold*: it stays true after `FULFILLED`; reap and cancel set it false. Re-reservation inserts **new rows with `generation+1`** and never flips old rows back; "same credits" = the items of the order's highest generation. |
| `demo_allocation_log` | immutable, one row per allocation **revision** (`0006`: an offer, then accept-partial, then possibly a new offer): order, `revision`, `as_of`, `cap_basis_q` (the original Q), per-group inputs (available, reserved, waiting-days), weights, cap, quota, per-group result, binding shortfall reason. |
| `demo_payment_attempts` | `id`, order, `provider` + `provider_ref` UNIQUE, `state`, `amount_paise`, `mismatch boolean`, `snapshot_hash`. Amount equals the order's `payable_paise` at creation. |
| `demo_payment_events` | **PRIMARY KEY `(provider, provider_event_id)`**, attempt, `type`, `payload_hash`, `amount_paise`, `outcome` (enum below), `received_at`. Insert-only and written **last, in the apply transaction** (so `outcome` is final at insert; nothing updates it). |
| `demo_payment_refunds` | `id`, order, attempt, `kind` (`LATE_UNFILLABLE`, `DUPLICATE_ATTEMPT`, `AMOUNT_MISMATCH`), `amount_paise` (the **captured** amount), `state` (`PENDING`, `REFUNDED`), UNIQUE `(attempt_id, kind)`. |
| `demo_ledger_entries` | append-only (trigger): one row per credit sold: `order_id`, `credit_id` UNIQUE, `payee_group_id`, `gross_paise`, `commission_paise`, `net_paise`, CHECK `gross = commission + net`, all ≥ 0. |
| `demo_group_state` | `(scenario_id, group_id)` PK, `last_allocated_at`; set **only on FULFILLED**. A group with no row is treated as never allocated (LEFT JOIN; `greatest` ignores NULL). |

`demo_buyer_limits` from revision 1 is **dropped**: under the scenario lock the buyer's open orders and reserved credits are counted directly.

Cross-table integrity: the order trigger cannot see credits and the credit guard cannot see orders, so a **deferred constraint trigger** on `demo_orders` fires when the state becomes `FULFILLED` and checks: active item count = `allocated_quantity`; every item's credit is `SOLD` with `reserved_order_id` = the order; ledger row count = `allocated_quantity`; `Σ gross = principal_paise`. Without it nothing stops `FULFILLED` with unsold credits.

**Payment outcome enum:** `FULFILLED`, `REVALIDATED_FULFILLED`, `REFUND_LATE_UNFILLABLE`, `REFUND_DUPLICATE_ATTEMPT`, `AMOUNT_MISMATCH`, `ATTEMPT_UPDATED`, `IGNORED_SAME_ATTEMPT`, `IGNORED_TERMINAL`.

## 6. Operations and API

All routes under `/api/v1`, session + CSRF on writes (except the webhook), scenario and buyer derived from the session. The client supplies only `quantity`, `requestId` and (optionally) a quote.

| Route | Behaviour |
|---|---|
| `GET /market/inventory` | AVAILABLE counts, price in force, per-group labels and availability. |
| `POST /orders` `{requestId, quantity, quotedTotalPaise?}` | §6.3. Replays return the stored order; reuse of `requestId` with a different `quantity` or quote is `KEY_REUSE`. |
| `POST /orders/:id/accept-partial` | §6.3. |
| `POST /orders/:id/payment-attempts` `{acceptSnapshotHash}` | Locked; reaps first, then checks ownership and state. `acceptSnapshotHash` is **always required** and must equal the order's `snapshotHash` (price, quantity, amount, commission, tax rule), so a buyer can only pay for the exact terms they were shown. One open attempt at a time; asking again returns it. A `payment.pending` event extends the reservation. |
| `POST /orders/:id/cancel` | Locked; releases credits, `active=false`, order `CANCELLED`. Refused once `FULFILLED`. |
| `GET /orders`, `GET /orders/:id` | Own orders only, **rebuilt from stored rows** (order, items, allocation log, attempts, refunds, purchased credits with their price), never recomputed. The commission/net split is not shown to buyers. |
| `POST /payments/webhooks/simulator` | §6.1. No cookie, no CSRF; signature only. Absent `PAYMENT_WEBHOOK_SECRET` → 404. |
| `GET /demo/orders` | Presenter only, `DEMO_MODE` only: the scenario's 20 most recent orders (state, amounts, latest payment state, pending refunds), so the presenter can drive the simulator from a second window while the buyer shops in the first. No farmer data. |
| `POST /demo/orders/:id/simulate` `{outcome}` | Presenter only, `DEMO_MODE` only. Outcomes: `pending`, `success`, `failure`, `replay` (the last event, rebuilt byte-for-byte), `double_charge` (a second attempt succeeds), `late_success`, `refund` (settle pending refunds). **It must run its prelude** (for `late_success`: advance `reserved_until` and run `reapExpired`) **in its own short transaction that commits, and then call `handlePaymentEvent` with no transaction open**, so it never holds the scenario lock while the handler takes it. |

### 6.1 Webhook and success handler

```
handlePaymentEvent(db, {body: Buffer, signature, timestamp}, opts?) → {status: 200|401|404|409|503, outcome?}
```

**Before any transaction:** verify `HMAC-SHA256(secret, timestamp + "." + rawBody)` in constant time (length and hex pre-check), accepting either of two configured secrets (rotation); timestamp within ±5 minutes of the app clock; body size cap; per-IP rate limit. Fastify keeps the **raw body** for this route. Failures return 401 and write nothing. Resolve `scenario_id` and `order_id` from `provider_ref` (immutable, unlocked read); an unknown `provider_ref` returns 404, writes nothing, and increments a metric.

**One transaction inside `withScenarioLock`:**

1. `SELECT` the event by `(provider, provider_event_id)`. If found, compare `payload_hash`: equal → return the stored outcome (idempotent replay); different → 409 `EVENT_REUSE` plus a metric. No side effects either way.
2. Lock the order, then the attempt, then the order's credits ascending (the highest-generation items and any credit with `reserved_order_id` = this order).
3. Decide, first match wins:
   - success, **amount or currency differs** from `attempt.amount_paise`, or the attempt differs from `order.payable_paise`: attempt → `SUCCEEDED` with `mismatch=true`; insert refund `AMOUNT_MISMATCH` for the **event** amount; order untouched. Outcome `AMOUNT_MISMATCH`. (Checked first so no branch strands captured money.)
   - success, attempt already `SUCCEEDED`: `IGNORED_SAME_ATTEMPT`. **No refund** (it is the same charge).
   - failure/cancel: apply only if the attempt is `CREATED`/`PENDING`, else `IGNORED_TERMINAL`. A failure never regresses a `SUCCEEDED` attempt.
   - success on a **different attempt**, order already `FULFILLED`/`REFUND_PENDING`/`REFUNDED`: attempt → `SUCCEEDED`, refund `DUPLICATE_ATTEMPT` for the event amount, order unchanged.
   - success, order `RESERVED`/`AWAITING_PAYMENT`, every credit `RESERVED` for this order with an active item (**even if `reserved_until` has passed and the reaper has not run**): fulfil.
   - otherwise (ownership broken, or order `EXPIRED`/`CANCELLED`): order → `REVALIDATING`. **Check first, then write**: lock all the order's credits ascending; if every one is `AVAILABLE`, insert new items (`generation+1`), set them `RESERVED` then `SOLD`, fulfil (quota-exempt; outcome `REVALIDATED_FULFILLED`). If any is not available, write nothing to credits; order → `REFUND_PENDING`, refund `LATE_UNFILLABLE`. No partial fill after payment.
4. **Fulfil**, in this order: credits `RESERVED → SOLD`; one ledger row per credit; `demo_group_state.last_allocated_at = asOf` per group; attempt `SUCCEEDED`; order `FULFILLED`; audit event (B12). The deferred constraint trigger checks the result at commit.
5. **Insert the `demo_payment_events` row last, with its final outcome**, then commit. Any exception rolls back everything including the event row and returns 503, so the provider's redelivery is applied from scratch. A 23505 on the event key means another transaction applied it first: re-read in a fresh transaction and return the stored outcome. Repeated 503s for one event id are counted (`payment_event_5xx_total`) so a deterministic apply failure is visible (wired in build step 5 with the other metrics).

`settleRefunds(db, scenarioId)`: under the lock, `PENDING → REFUNDED`; then each `REFUND_PENDING` order with no remaining `PENDING` refund → `REFUNDED`. Driven by the simulator `refund` outcome and by the worker, so the refund path is testable and demonstrable.

### 6.2 Reservation reaping

`reapExpired(tx, scenarioId, asOf)` is callable **only inside `withScenarioLock`**. It runs at the start of every allocation and from the worker sweep (`marketSweep`), which takes the lock only when an unlocked pre-check finds due work. The sweep also settles refunds once they are `MARKET_REFUND_SETTLE_SECONDS` old (default 600, so `REFUND_PENDING` stays visible; `off` leaves settlement to the presenter) and runs `assertMarketInvariants` every `MARKET_INVARIANT_EVERY_SECONDS`. A failing sweep is counted and logged but does not stop chaining or proofs. Orders in ascending id, credits ascending: orders past `reserved_until` → `EXPIRED`, items `active=false`, credits `RESERVED → AVAILABLE` with `reserved_order_id` cleared; `CREATED` orders older than 15 minutes → `CANCELLED`. **It makes no provider call.** (Revision 1 had the reaper ask the simulator under the lock, which is an RPC inside a lock; the late-success path already handles the race that call guarded against.) The worker cycle gains a market sweep with metrics.

### 6.3 `POST /orders` and FCAE v0

```
createOrder(db, actor: BuyerActor, {requestId, quantity, quotedTotalPaise?}) → OrderView
allocateFcaeV0(inputs, q, {take?, capBasisQ, skipQuota}) → result      // pure, no I/O
```

One `withScenarioLock`: (1) replay lookup by `(scenario_id, buyer_id, request_id)` **before the reap**, as `beginUpload` does; the hash covers `quantity` and `quotedTotalPaise`. (2) `reapExpired`. (3) buyer limits (B11) → `422 BUYER_LIMIT`. (4) price at `asOf` (`PRICE_NOT_CONFIGURED` aborts and rolls back). (5) recount groups and run FCAE. (6) *Shortfall:* insert the order in `CREATED` with `shortfall_reason` and the allocation log; no credits touched. *Otherwise:* insert the order `RESERVED`, lock credits ascending, insert items (generation 1), set credits `RESERVED` with `reserved_order_id`, log, audit. A 23505 on the request key or item index is mapped to "re-read in a fresh transaction", never a 500.

FCAE v0 inputs, under the lock: per group `a_g`, `r_g`, `waiting_days_g = ⌊(asOf − max(last_allocated_at_g, oldest_available_at_g))/1 day⌋` where `oldest_available_at_g` is the minimum `available_since` of its AVAILABLE credits. `u_g = min(a_g, cap, room_g)`, `cap = max(1, ⌊0.15·capBasisQ⌋)`, `room_g = max(0, quota_g − r_g)`, `quota_g = max(1, ⌊0.5·(a_g+r_g)⌋)`. If `Σu_g < Q`, shortfall with the binding reason (`SUPPLY`, `CAP`, `QUOTA`); the cap is never silently relaxed. Otherwise fill by descending `waiting_days_g`, ascending group id, one credit per round, lowest credit id first.

**Partial fill.** `accept-partial` re-runs allocation under the lock with `take = k` (the offered count) and `capBasisQ` = the **original** Q, so the cap does not shrink. If supply changed so `k` is no longer feasible, it returns a **new shortfall**, never a silent smaller order. On success `allocated_quantity = k` and `principal = unit_price × k`. A quote comparison uses `quantity × price`, not the allocated amount.

## 7. Failure modes

| Failure | Detection | Required behaviour | Test |
|---|---|---|---|
| Two buyers take the last credits | partial unique index; scenario lock | exactly one wins; the other gets a shortfall (`SUPPLY`), never a 500 | pg race |
| Same `requestId` sent twice concurrently | unique `(scenario, buyer, request_id)` | one order, identical response; different body → `KEY_REUSE`; same id from two buyers → two orders | pg race |
| Webhook delivered twice, in parallel | event PK, checked under the lock | one fulfilment, one set of ledger rows | pg race |
| Apply rolls back after verification | event row written last | no event row; redelivery applies from scratch | pglite (forced trigger error) + pg |
| Same event id, different body | payload hash compare | 409 `EVENT_REUSE`, no change | pglite |
| Second success event, **same attempt** | attempt absorbing | `IGNORED_SAME_ATTEMPT`, **no refund** | pglite |
| Second attempt also succeeds | order already fulfilled | `DUPLICATE_ATTEMPT` refund; order unchanged | pglite + pg race |
| Amount or currency mismatch (any branch) | check first | `AMOUNT_MISMATCH` refund for the event amount; order untouched; metric | pglite |
| Success after expiry, credits free | ownership check → REVALIDATING | same credits re-reserved, fulfilled | pglite |
| Success after expiry, a credit taken | REVALIDATING fails | `REFUND_PENDING` then `REFUNDED`; no credit sold | pglite + pg race |
| Success after the buyer **cancelled** | same path | fulfils if the credits are free, else refund (B10) | pglite |
| Expiry racing payment success | one scenario lock, both lock orders | consistent either way; no credit held by two orders | pg race |
| Failure event after success (out of order) | attempt absorbing | attempt stays `SUCCEEDED` | pglite |
| Failed attempt, buyer abandons | `reserved_until` | order stays `AWAITING_PAYMENT`, reaper expires it, credits released | pglite |
| Shortfall order left in `CREATED` | sweep | cancelled after 15 min; not counted as open | pglite |
| Bad/missing signature, stale or future timestamp, tampered body, rotated secret | pre-transaction verify | 401, no writes | pglite |
| Valid signature, unknown `provider_ref` | resolve step | 404, no row, metric | pglite |
| Cross-buyer or cross-scenario order access | ownership predicate | 404 | pglite |
| Agent/verifier on buyer routes; buyer on agent routes | role check | 403 | pglite |
| Quote differs from price | `quotedTotalPaise` mismatch | `priceChangedFromQuote`; attempt requires `acceptSnapshotHash` | pglite |
| No price configured | resolve step | `PRICE_NOT_CONFIGURED`, rollback | pglite |
| Buyer over limit | counts under lock | `422 BUYER_LIMIT` | pglite |
| Simulate called while a lock is held (misuse) | design rule | prelude commits first; test documents the hang | pg |
| Cancel × reaper × webhook × create interleaved | single lock helper | zero deadlocks (SQLSTATE 40P01 count = 0) | pg race |
| `FULFILLED` with unsold credits / missing ledger / gross mismatch | deferred constraint trigger | commit fails | pglite |
| Database down during webhook | 503 | event not recorded; redelivery applies once | pglite |
| Money overflow or float | `bigint`, CHECKs | large quantity × price exact | unit |

## 8. Invariants (scheduled checks and test oracles)

1. A credit is `SOLD` ⇔ it has exactly one ledger row, `reserved_order_id` is a `FULFILLED` order, and that order's active item for the credit exists.
2. A credit is `RESERVED` ⇔ it has exactly one active item and its order is `RESERVED`, `AWAITING_PAYMENT` or `REVALIDATING`.
3. No reservation outlives `reserved_until` by more than one sweep interval, except through an unreaped order whose success is still applicable.
4. For every `FULFILLED` order: `Σ gross = principal_paise = unit_price_paise × allocated_quantity`, `Σ commission + Σ net = Σ gross`, and exactly one payment event with outcome `FULFILLED`/`REVALIDATED_FULFILLED` whose amount equals `payable_paise`.
5. Every `REFUND_PENDING`/`REFUNDED` order has zero `SOLD` credits and refunds that sum to the captured amount.
6. `demo_group_state.last_allocated_at` is changed only for groups with a `FULFILLED` order.
7. The audit chain stays verified (`verifyAuditFull`) after any sequence of the above.

`assertMarketInvariants(db)` is the oracle for every test and a worker check (`greenchain_market_invariant_violations`).

## 9. Security, privacy, observability

- Buyer identity from session only; every query filters `scenario_id` and `buyer_id`; tests cover IDOR on order, attempt and ledger ids.
- Webhook: signature covers timestamp and raw body; constant-time compare; two-secret rotation; body cap and rate limit; exempt from cookie/CSRF; never logs the secret or signature (add `PAYMENT_WEBHOOK_SECRET`, `signature` to the logger redact list). Replaying a captured signed request is harmless because applies are idempotent; the window mainly bounds abuse after a secret leak. If a real provider sends no timestamp, the window moves into that adapter.
- No farmer PII in buyer responses (test asserts fixture label/village strings never appear).
- `simulate` exists only when `DEMO_MODE` is on and only for `demo_namespaces` scenarios. Every buyer screen and response carries "Demonstration — synthetic credits and simulated payments" and `namespace: "DEMO_ONLY"`.
- Logs (structured, no secrets): `requestId, scenarioId, orderId, attemptId, eventId, outcome, lockWaitMs, txMs`. Metrics: `payment_events_total{outcome}`, `webhook_rejected_total{reason}`, `payment_event_5xx_total`, `payment_unmatched_total`, `refunds_pending`, `scenario_lock_wait_ms`, `orders_created_total{result}`, `reservations_reaped_total`, `orders_by_state`, `market_invariant_violations`.

## 10. Deviations from the production design

| Production (doc 06/09) | This slice | Trigger to remove the deviation |
|---|---|---|
| Per-credit-type advisory locks, six lock classes | Scenario row lock via one helper | A second credit type or throughput beyond one lock per scenario |
| Maintained `farmer_available` aggregate | Recount | ~10k credits per scenario or p95 allocation > 200 ms |
| Price book with state/vintage keys, tax rules, invoices | Flat effective-dated price, zero-tax marker | Invoicing slice |
| FRPS tier weights | Weight 1 | FRPS tiers exist |
| `cap_override` | Not available | Pilot with fewer than 7 groups |
| Per-buyer limits row (lock 0) | Counts under the scenario lock | Per-type locks replace the scenario lock |
| Journal/lots/reserve in the same transaction | Per-credit ledger rows only | Payout slice |
| Payee group nomination | Group = case | Payee nomination feature |
| Sweeper asks the provider before expiring a PENDING attempt | No provider call; late-success path covers it | A real provider with observable pending state |

## 11. Test plan

PGlite is single-connection: it proves logic and constraints, **not locking**. Every race below runs on real PostgreSQL (`npm run test:pg`) with parallel connections and gets a **mutation check** (remove the lock, index or trigger; watch the test go red), as for the existing suite.

**PGlite:** price resolution; FCAE v0 (determinism with shuffled input, cap, quota, shortfall reasons, `capBasisQ` stability on partial fill); every legal and illegal order and attempt transition; each failure row marked pglite; deferred constraint trigger; money rounding (half-even, large values); role matrix; PII absence; `assertMarketInvariants` after every scenario; `verifyAuditFull` at the end.

**Real PostgreSQL:** last-credit race with N buyers; concurrent identical and conflicting `requestId`; duplicate and parallel webhooks; two attempts succeeding in parallel (one fulfilment, one refund); expiry vs success in both lock orders; cancel × reaper × webhook × create with random interleavings and a deadlock count of zero; `asOf` taken after the lock wait; forced failure mid-apply then redelivery.

**Smoke:** `scripts/demo-market-smoke.mjs` runs the presentation path (browse, order, allocation explanation, pay, replay the callback, unchanged ledger) against a running local API and prints the invariant report.

## 12. Build sequence (each step ends with tests green and a commit)

1. **Migration 0005 and constraint tests first** (PGlite): tables, `available_since`, `reserved_order_id`, extended credit guard, order/attempt triggers, deferred constraint trigger, role widening. FCAE v0 and commission math as pure functions with property tests.
2. **`withScenarioLock`, `reapExpired`, `createOrder`, `accept-partial`, `cancel`**, `assertMarketInvariants`; PGlite tests; pg races: last credit, `requestId`, reaper/create/cancel interleaving.
3. **Payment port, simulator, `handlePaymentEvent`, `settleRefunds`:** all decision branches; pg races: duplicate and parallel webhooks, two attempts, expiry vs success, forced-rollback redelivery.
4. **HTTP routes** (raw-body capture for the webhook, buyer role, CSRF exemption), **seed** (20 groups × 10 credits, buyer account, price list), auth/IDOR tests.
5. **Worker sweep, metrics, invariant check;** README and docs 17/22 status.
6. **Web:** marketplace and order, allocation explanation, payment status, presenter simulate panel, banner. Manual device checks stay deferred as before.

## 13. Open questions (defaults apply unless you change them)

1. **Flat price vs price book (B3).** Default: flat. The alternative adds vintage/state keys and a publish workflow.
2. **Seed size.** Default: 20 groups × 10 credits by direct seed (the real issuance path yields 1–2 credits per case). With B11 this caps an order at about 20.
3. **Commission rate.** Default: 5% (500 bps), the placeholder from doc 09's worked example.
4. **Refund realism.** Default: refunds stay `REFUND_PENDING` until the presenter triggers `refund` (or the worker's next settle), so the interval is visible.
5. **Buyer sign-in.** Default: one seeded buyer in the `presenter` scenario.

## 14. What revision 2 changed (from the independent design review)

Critical: the payment-event row was written before the apply transaction, so a rollback lost a captured payment (now written last, in the same transaction); a second success on the *same* attempt would have refunded a legitimate fulfilment (now `IGNORED_SAME_ATTEMPT`, refund only for a different attempt). High: amount mismatch was checked on one branch only; simulate could deadlock by calling the handler under the lock; the reaper made a provider call inside the lock; `cancel`/`accept-partial`/refund paths had no defined lock order; `active` item semantics and re-reservation against the partial unique index were undefined; partial fills broke the principal CHECK and shrank the cap; `EXPIRED`/`CANCELLED` could not reach `REVALIDATING`. Medium: webhook signature did not cover the timestamp or raw body, no rotation, no body cap; `demo_credits.available_since` did not exist; `audit_events` requires a case (decision B12); `demo_buyer_limits` was redundant; `now()` is stale after a lock wait; commission rounding must be done in BigInt.
