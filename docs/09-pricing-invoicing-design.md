# 09 · Order Pricing & Invoicing — Design

Status: Draft v3 (revised after two technical reviews; **not yet implemented**) · Related: [06-technical-design.md](06-technical-design.md) §3, §4.2, §6, §9 · [01-prd.md](01-prd.md) FR-MKT-1, FR-ORD-*, FR-PAY-*, FR-LED-1 · Stories S9.1, S9.3, S10.1, S10.4, S10.7 in [05](05-backlog-story-points.md) · Style and two-person publication pattern follow [08](08-mrv-module-design.md).

> **All numeric values are PLACEHOLDERS. No tax rate, tax rule or legal requirement is asserted in this document.** Every tax-specific statement is marked **[CONFIRM]** and is to be settled by an accountant or legal advisor (open questions T-1…T-9).

---

## 1. Decisions and context
- **Pricing rule:** admin-published, effective-dated price list by credit type + vintage (optionally state). No bidding (extends D6, Q-OQ-6).
- **Invoicing model:** marketplace/agent model. The farmer (payee) is the supplier; the buyer pays the gross price; the ledger deducts the FRPS-tier commission from the farmer's share; the platform issues a **buyer receipt** and a **commission invoice** per order. The tax treatment of this model is **[CONFIRM]**.
- **Component type:** a synchronous command inside `POST /orders` (prices the order within the FCAE allocation transaction) plus an async invoice job after fulfilment. Load is a handful of orders per minute; correctness and paise exactness dominate.
- **Stack:** Node + TS modular monolith, Postgres job queue, no Redis.

## 2. Module boundaries

```
src/modules/pricing/    index.ts (priceOrder, getQuote)
  domain/    money.ts (bigint paise, half-even)  resolve.ts  errors.ts     (pure, no I/O)
  application/ publishPriceList.ts  quote.ts
  infra/     repos     http/ admin + buyer routes      (receives the allocation **by value**; no port into `market`, so there is no pricing↔market cycle)
src/modules/invoicing/  index.ts (enqueueInvoicing, event handlers)
  domain/    build.ts (ledger lines → documents)  reconcile.ts  numbering.ts
  application/ generateInvoices.ts  draftCreditNote.ts  issueCreditNote.ts
  infra/     repos, port: LedgerRead (public ledger API)     http/ finance + buyer routes
```
`priceOrder(tx, allocation)` shares the allocation transaction and its `as_of` (06 §6); `market → pricing` is the only direction. **`tax_rules` are owned by `pricing`** (they are resolved at order time); `invoicing` reads snapshots and ledger rows through read ports (`LedgerRead`, `OrderRead`, `PaymentRead`) and never resolves tax itself. Modules do not read each other's tables (06 §1).

## 3. Data model (PKs UUIDv7; money as `BIGINT` paise; `CHECK > 0` on prices)

| Table | Key columns and constraints |
|---|---|
| `price_lists` | version, status `DRAFT/IN_REVIEW/PUBLISHED/RETIRED`, `effective_from` UNIQUE, created_by, approved_by. `CHECK (status<>'PUBLISHED' OR approved_by<>created_by)`; a **DEFERRABLE INITIALLY DEFERRED constraint trigger** checks `effective_from >= commit time + margin` at commit (margin default 5 min **[A]**; a plain row trigger would only see statement time); no UPDATE once PUBLISHED except `PUBLISHED → RETIRED`; a list is retired only by a job after its successor's `effective_from` has passed (never by the publish itself) |
| `price_list_entries` | price_list_id, credit_type, vintage_year, state_code NULL, `price_paise_per_t`. UNIQUE on `(list, type, vintage, COALESCE(state,'*'))`; **immutable once its list is PUBLISHED**, including no INSERT of new entries into a PUBLISHED list (the trigger locks the parent list row) |
| `order_price_snapshots` | order_id UNIQUE, price_list_id, as_of, principal_paise, tax_paise DEFAULT 0, payable_paise. `CHECK (payable = principal + tax)`; immutable |
| `order_tax_lines` | order_id, order_item_id, kind (`PRINCIPAL_TAX`), `tax_rule_id`, `rule_version`, `rate_bps`, `amount_paise` — resolved **at order time** from the rule in force at `as_of` and snapshotted; immutable |
| `order_item_commission` | order_item_id, `commission_bps`, `tier`, `tier_event_seq`, `commission_tax_rule_id`, `commission_tax_rate_bps`, `commission_tax_amount_paise` — resolved **at allocation** (tier from market's FRPS projection, schedule from FRPS, tax rule from `pricing`) and snapshotted; the ledger **copies** these at FULFILLED and never re-resolves, so fulfilment cannot fail on a missing or expired rule |
| `order_items` (+cols) | `unit_price_paise NOT NULL`, `price_list_entry_id NOT NULL`, immutable |
| `invoice_series` | doc_type, scope (fiscal year **[CONFIRM]**), prefix, `next_no`; UNIQUE (doc_type, scope) |
| `invoices` | order_id, doc_type `BUYER_RECEIPT / COMMISSION_INVOICE / CREDIT_NOTE`, status `DRAFT/ISSUED/CREDIT_NOTED`, series_id, number NULL, recipient_id, party snapshot (encrypted), total_paise, original_invoice_id NULL. `UNIQUE (series_id, number)`; `CHECK (status='DRAFT' OR number IS NOT NULL)`; partial UNIQUE `(order_id, doc_type, recipient_id) WHERE doc_type<>'CREDIT_NOTE'` |
| `invoice_lines` | invoice_id, `doc_type` (denormalised from the parent), `ledger_entry_id` (UNIQUE per invoice), kind `PRINCIPAL/COMMISSION/TAX`, credit_id, tonnes, unit_paise, amount_paise, tax_rule_id NULL; **partial UNIQUE `(ledger_entry_id, kind) WHERE doc_type = 'CREDIT_NOTE'`** so a duplicate `LedgerReversalPosted` event cannot create a second credit note |
| `tax_rules` (owned by `pricing`) | code, version, applies_to (item type × party), `rate_bps` NULL (an explicit zero/exempt rule is still a rule), effective_from, status, created_by, approved_by; same two-person publication; **values supplied by the accountant [CONFIRM]** |

- **Supersedes 06 §3:** `orders.price_paise_per_t` is replaced by per-item prices (vintages can differ within one order).
- **Roles:** `app_user` has INSERT on `invoices` and `invoice_lines` and **column-level UPDATE** only on `status`, `number` and `issued_at` of DRAFT invoices (needed for DRAFT → ISSUED). A trigger allows only `DRAFT → ISSUED` and `ISSUED → CREDIT_NOTED`, and rejects any change to numbered rows or their lines. No DELETE anywhere.
- **Commission** (`commission_bps`, tier snapshot) and the **tax on commission** are snapshotted onto `order_item_commission` at allocation and copied onto `ledger_entries` when the order is FULFILLED. Invoicing reads the ledger rows and never recomputes or re-resolves anything.
- **Invariants:** integer paise only; price snapshot immutable; `Σ invoice lines = ledger gross`; invoice numbers gap-free per series and immutable once ISSUED; tax lines separate from principal.

## 4. Price resolution and the `POST /orders` contract
1. Read `as_of` once (shared with the FCAE allocation log).
2. Select the PUBLISHED, not-yet-retired list with the greatest `effective_from <= as_of`. A list is a complete price book; there is no fall-through to older lists. Because a list is never retired before its successor is effective, and `effective_from` is unique, exactly one list is in force at any instant.
3. For each allocated credit (type, vintage, plot state) take the entry whose state matches, else the entry with `state IS NULL`. A miss raises `PRICE_NOT_CONFIGURED`, which rolls back the whole transaction (no reservation, no default).
4. Write the snapshot and item prices in the same transaction as the reservations.

**Priced-key filter:** before allocation `market` reads the set of priced `(type, vintage, state)` keys of the list in force from `pricing` (an allowed `market → pricing` direction) and only considers credits whose key is priced. Stock with no price entry (a new vintage or state issued after the list was published) is excluded from allocation and reported to admins, so one unpriced credit can never roll back an order that could be filled from priced stock.

**Why a concurrent publish cannot split an order:** `published_at` is the transaction's clock, so publication alone is not enough; the trigger therefore requires `effective_from >= clock_timestamp() + margin`, meaning a list only becomes the list-in-force after the margin has passed, by which time its short publish transaction has committed (a commit slower than the margin fails the publish and it is retried with a new `effective_from`). An order always replays from its snapshot's `price_list_id`, never by re-resolving.

**Publish validation:** (a) completeness against live inventory: every `(type, vintage, state)` with AVAILABLE credits has an entry; (b) **tax coverage on both sides**: an effective tax rule (possibly an explicit zero/exempt rule decided by the accountant) exists for every item type and party the list prices *and* for the commission side, and a tax rule's validity may not end before a list that depends on it is retired unless a successor rule is already published (checked again at tax-rule publish); (c) optional change guardrail (P-2). A published list can be **withdrawn** in an emergency (§9), which reinstates its predecessor.

**Tax and commission at order time:** principal tax lines are resolved from the rule in force at `as_of` and snapshotted in `order_tax_lines`; the commission schedule, the farmer's FRPS tier (from `market`'s event-fed projection) and the commission-side tax rule are snapshotted per item in `order_item_commission`. `payable_paise` already includes principal tax. A missing rule raises `TAX_RULE_NOT_CONFIGURED` and rolls the order back (like a missing price), so by fulfilment time nothing remains to be resolved.

**Response**
```
{ order_id, price_snapshot_id, currency:"INR", price_list_id, as_of,
  lines:[{credit_type, vintage, state, tonnes, unit_price_paise, line_paise}],
  principal_paise, tax_lines:[], payable_paise, price_changed_from_quote, expires_at,
  allocation, shortfall, payment_session }
```
- `expires_at` equals `reserved_until` (06 §4.2).
- If the buyer sent `quoted_total_paise` and it differs, `price_changed_from_quote = true`; creating a payment attempt then requires `accept_snapshot_id` to equal the snapshot.
- `payable_paise` (principal + snapshotted tax) must equal the payment attempt's `amount_paise` (F10.6).
- A cheap pre-flight price check against the buyer's filters runs before FCAE to avoid wasted allocation work.

## 5. Money-math rules
- Integer paise as `bigint`; no floats and no JS `number` for money.
- `line = unit_price_paise × tonnes` is exact (whole tonnes only).
- `commission = round_half_even(gross × commission_bps / 10000)` **per ledger line**; `net = gross − commission`, so the remainder is zero by construction. The order-level assertion `Σ gross = Σ commission + Σ net` aborts the transaction if violated.
- Tax is computed **at order time** from the PUBLISHED `tax_rules` row in force at `as_of`, per line, and stored in `order_tax_lines`; invoices copy the snapshot into `TAX` lines. A missing rule is an order-time error (`TAX_RULE_NOT_CONFIGURED`), prevented in practice by the publish validation in §4.
- Tax per line = `round_half_even(base × rate_bps / 10000)` to whole paise, applied per line, never to an order total **[CONFIRM T-1/T-4]**.
- Gateway fees are platform cost and never deducted from the farmer **[CONFIRM]** (also depends on Q-OQ-5 owner).

**Worked example (PLACEHOLDER values: 2 credits, commission 500 bps, tax omitted)**

| Line | Gross (paise) | Exact commission | Half-even | Net |
|---|---|---|---|---|
| 2025 vintage | 100030 | 5001.5 | **5002** | 95028 |
| 2026 vintage | 100010 | 5000.5 | **5000** | 95010 |
| Order | 200040 | | 10002 | 190038 |

Check: 10002 + 190038 = 200040. Buyer receipt shows 200040; commission invoice shows 10002; farmer's share is 190038.

## 6. Reconciliation invariant
For every order that is **fully invoiced** (all documents ISSUED, including any credit note already posted) or older than the invoicing SLA (default 1 h **[A]**), using ledger totals net of reversals. A reversal that is posted but whose credit note is still DRAFT is excluded from this check and is covered by the separate age alert below:
- `Σ BUYER_RECEIPT principal lines − Σ credit-note principal lines = Σ ledger gross`
- `Σ COMMISSION lines − Σ commission credit notes = Σ ledger commission`
- `Σ commission-invoice TAX lines = Σ ledger commission tax = Σ order_item_commission tax`
- per line: `commission + net = gross`
- `Σ ledger gross = Σ order_items price = (captured payment − tax collected) − refunds`  (tax is compared against `Σ order_tax_lines`; captured payment equals `payable_paise`)

A scheduled job checks all of these (06 §11); any non-zero difference pages. A separate alert fires when a **reversal has no ISSUED credit note after the SLA** (reversal awaiting credit note).

## 7. Invoice job lifecycle

```
ENQUEUED → RUNNING → ISSUED
                   → RETRY (transient, backoff, max 5) → DEAD_LETTER
```
- **Trigger:** enqueue via outbox when the order reaches `FULFILLED` (not PAID). Between PAID and FULFILLED, 06 §4.2 can still void and pro-rata-refund lines, so invoicing earlier would force avoidable credit notes. Revisit if a supply-time rule requires invoicing at payment **[CONFIRM, T-3 / P-3]**.
- **Steps:** read ledger rows through the port → build documents (one receipt per order; one commission invoice per payee per order) → copy the tax snapshot (order-time lines and the ledger's commission tax; nothing is re-resolved) → in one transaction: lock the needed `invoice_series` rows **in ascending series id** (receipt and commission series are always locked in the same order, so concurrent jobs cannot deadlock), assign `next_no`, insert invoice and lines, set ISSUED.
- **Why a row lock:** a rollback also rolls back the counter, keeping numbers gap-free (a sequence object would leave gaps). Existence of the invoice is checked **before** the counter is incremented, or the whole transaction aborts on a unique violation; `ON CONFLICT DO NOTHING` after incrementing is forbidden because it would leave a gap. The partial UNIQUE `(order_id, doc_type, recipient_id)` makes replays no-ops, so no advisory lock is needed. The fiscal-year scope of a series is computed from the **IST date** **[CONFIRM T-6]**.
- Invoicing consumes snapshots, so it cannot be blocked by a missing tax rule and can never block a sale.

## 8. Credit notes (06 §4.2, §9; F10.8)
- **Triggers:** a `LedgerReversalPosted` event (reversal, chargeback, post-fulfilment refund; Q-OQ-4), and a pro-rata refund of a voided line.
- **Late-success refund when the order was never PAID:** no invoice exists, so no credit note.
- **Reversal arriving before the original is ISSUED:** the invoice job always issues originals first; the drafter retries with backoff (up to 24 h **[A]**) until the original exists, then alerts. The original invoice is always built from the FULFILLED-time ledger rows (excluding later reversals); reversals only ever appear as credit notes.
- **Drafting:** build a `CREDIT_NOTE` DRAFT from the reversal ledger rows with `original_invoice_id` and one line per reversed ledger entry; partial and per-credit notes are supported; a matching commission credit note is drafted too.
- **Issuing:** finance issues them (own series, same numbering transaction). The original becomes `CREDIT_NOTED` when Σ credit notes equals its total.
- A REPLACEMENT credit issues no new invoice; `reversed_after_retire` leaves the original document unchanged. Issued rows are never edited.

## 9. API and admin surface

| Endpoint | Role |
|---|---|
| `GET /market/credits` (prices from the effective list), `POST /orders` | buyer |
| `GET /orders/:id/price-snapshot`, `GET /invoices`, `GET /invoices/:id` (own only) | buyer |
| `POST /admin/price-lists`, `…/:id/entries`, `…/:id/submit`, `…/:id/approve` | admin author / second admin |
| `GET /admin/price-lists/:id/diff` (against current) | admin |
| `POST /admin/price-lists/:id/withdraw` (retires the list immediately and reinstates its predecessor; orders already placed replay from their snapshots) | admin author + second admin (urgent) |
| `GET /finance/invoices`, `POST /finance/credit-notes/:id/issue`, `GET /finance/reconciliation` | finance |
| `POST /admin/tax-rules…` (same flow) | admin / second admin |

## 10. Authorization and failure modes
Enforcement is by DB roles (no UPDATE/DELETE on issued rows) plus an application guard for buyer ownership; the two-person rule is a CHECK as in 08 §6. Every publish, issue and credit note writes an audit row in the same transaction.

| Failure | Detect | Recover |
|---|---|---|
| Missing price | `PRICE_NOT_CONFIGURED`, metric, alert | Admin publishes; buyer retries |
| Price changed since browse | `price_changed_from_quote` | Buyer re-confirms the snapshot |
| Rounding drift | Order-level assertion | Transaction aborts; page |
| Duplicate invoice number | UNIQUE + row lock | Retry |
| No tax rule for an order | `TAX_RULE_NOT_CONFIGURED` at order time; publish validation requires tax coverage | Admin publishes a rule; buyer retries |
| Amount mismatch (F10.6) | payable vs attempt amount | Hold and alert |
| Mid-order publish | `effective_from ≥ commit + margin`, unique `effective_from`, order replays from its snapshot | Bounded by the margin; a slow publish commit fails and is retried |

Replays are safe: the POST /orders idempotency key returns the same priced order, and invoices are keyed by the UNIQUE constraint.

## 11. Test plan
- **Golden:** the worked example, .5 tie cases (even and odd neighbours), single-credit order, multi-vintage mixes; assert exact paise strings.
- **Property tests:** `Σ lines = principal`; `commission + net = gross`; determinism under shuffled input; commission within ±1 paise of the exact value; no negatives; credit notes never exceed the original.
- **Failure injection:** kill the worker mid-issue and re-run ⇒ one number, no gap; 50 concurrent issues ⇒ contiguous numbers; publish mid-order ⇒ order uses its `as_of` list; missing price ⇒ no reservation row remains; missing tax rule ⇒ order rolled back with `TAX_RULE_NOT_CONFIGURED` and no reservation left, and a price list without tax coverage ⇒ publish rejected; publish committing later than the margin ⇒ rejected and retried; duplicate webhook plus job double-delivery ⇒ one invoice set; UPDATE of an ISSUED row ⇒ rejected.

## 12. Observability
- **Logs:** structured with `order_id, price_list_id, snapshot_id, invoice_id, series_id, number, doc_type, outcome, trace_id`, at pricing, issue, block and dead-letter.
- **Metrics:** `orders_without_price` (alert on any), invoice job lag and oldest age, credit-note rate, age of DRAFT credit notes, `recon_diff_paise` (must be 0 for in-scope orders), `orders_tax_rule_missing` (alert on any).
- **Health:** age of the last issued invoice; alert only when the queue is non-empty.

## 13. Build sequence
1. Migrations: price tables, snapshot and item columns, publish trigger, roles.
2. `money.ts` with golden and property tests (no DB).
3. `resolve.ts` and `priceOrder` wired into the allocation transaction (S9.1).
4. Price-list admin two-person flow and buyer read endpoints.
5. Idempotent `POST /orders` response contract (S9.3) and the attempt-amount check (S10.1).
6. Migrations: invoices, series, tax rules, immutability triggers.
7. `build.ts` and `generateInvoices` with row-lock numbering (S10.7).
8. Reconciliation job and metrics.
9. Credit-note drafter and finance issue flow (S7.4 hook).
10. Failure-injection suite.

## 14. Open questions

**Product**
| # | Question |
|---|---|
| P-1 | FR-MKT-1 says "price band", but we implement one resolved price per key. Keep a min/max band as a guardrail? |
| P-2 | Reject a publish that moves prices more than X% from the current list? |
| P-3 | Is enqueue at `FULFILLED` (instead of PAID) acceptable? |
| P-4 | Is the tier → `commission_bps` schedule owned by S10.4 and published two-person? |
| P-5 | Should buyers see prices per state, or only per type and vintage? |

**Tax and legal — all [CONFIRM] with an accountant or legal advisor**
| # | Question |
|---|---|
| T-1 | Is GST applicable to credit sales and to commission? On whom, at what rate, and what is the place of supply? |
| T-2 | TDS or TCS on payouts to farmers or on buyer payments, and who deducts? |
| T-3 | Is the buyer document a tax invoice or a receipt, and when must it be issued (payment or supply)? |
| T-4 | Is the price tax-inclusive or tax-exclusive? This changes `payable_paise` and the Razorpay amount (highest impact). |
| T-5 | Unregistered farmers as suppliers: reverse charge, and agent-model disclosure. |
| T-6 | Numbering rules: series per fiscal year, state or branch; gap-free requirements. |
| T-7 | Credit-note legality and time limits. |
| T-8 | Gateway fee treatment. |
| T-9 | Retention versus DPDP erasure for party snapshots on invoices (relates to Q-OQ-9). |
