# Demo credit retirement and retirement certificate

Status: **Signed off 2026-10-28; implemented on `feat/retirement` (2026-10-29). Validation in §6.**

Scope: doc 13 weeks 5–6, "retirement" (a secondary flow). It covers PRD FR-CRD-2 (`SOLD → RETIRED`, terminal), FR-CRT-1 ("retirement certificate"), user flow 03 §7 ("buyer retires credits, full or partial, for a reporting period"), and backlog S11.2. It builds on the purchase certificate of [24](24-demo-certificate-reset.md).

Not in scope:
- disputes, freezes and reversals, including `reversed_after_retire` (the next slice, if the core stays stable);
- anchoring retirements on chain;
- BRSR reports.

## 1. Decisions

| # | Decision | Reason |
|---|---|---|
| T1 | **The buyer retires its own SOLD credits**, all or some, in one request. It names a reporting period and an optional public purpose. | Flow 03 §7. A buyer retires credits to claim them against its own emissions. |
| | • Credits are chosen by count from one paid order, oldest credit id first, or by explicit credit ids from its paid orders. | |
| | • The reporting period is `FY2026-27` or a calendar year `2026`. | |
| | • The purpose is up to 120 characters of letters, digits and basic punctuation. It is shown publicly, and the UI says so. | |
| T2 | **RETIRED is terminal** (already true in the credit guard). | The credit cannot be sold, reserved or retired again. |
| | • The credit keeps `reserved_order_id`, so its owner and purchase stay traceable. | |
| | • The order's item stays active. | |
| | • A database trigger refuses `SOLD → RETIRED` unless the credit has a retirement item in the same transaction. | |
| T3 | **Records.** | The same frozen, hashed pattern as purchase certificates (doc 24 C1–C2). |
| | • `demo_retirements(id, scenario_id, buyer_id, request_id, reporting_period, purpose, credit_count, created_at)`, with `UNIQUE(scenario_id, buyer_id, request_id)` for replay. | |
| | • `demo_retirement_items(retirement_id, credit_id UNIQUE)`. | |
| | • Both are insert-only. | |
| T4 | **Retirement certificate**: one per retirement, frozen at retirement. | Verifiable exactly like a purchase certificate. |
| | • Its content gives credit ids, tonnes, vintage, groups by label, the reporting period and the purpose. It also lists the purchase certificate number of each source order when one was issued. | |
| | • It is stored in `demo_certificates` with a new `kind` (`PURCHASE` or `RETIREMENT`), keyed by retirement id for retirements. | |
| | • Numbers look like `GC-RETIRE-XXXX-XXXX`. | |
| | • The public verification route, `verify.html` and print-to-PDF work unchanged. | |
| T5 | **Public verification of a purchase certificate** also reports how many of its credits have since been retired, read live from stored rows. | The frozen content cannot change, but a reader should know a credit was retired after purchase. |
| T6 | **Rules carried over.** | |
| | • Retiring is new work, so it is refused in a retired scenario (`withNewWorkLock`, doc 24 R4). | |
| | • It runs under the scenario lock, then locks the credits in ascending id order (lock order steps 1 and 4). | |
| | • It does not touch the ledger, journals or payouts: no money moves. | |
| | • It is audited, anchored to a group of the source order. | |
| T7 | **Invariants.** | Doc 22 §8 extended. |
| | • `HOLD_WITHOUT_CREDIT` accepts RETIRED. | |
| | • `SOLD_WITHOUT_FULFILMENT` is extended to RETIRED: one ledger row, a FULFILLED owner and an active hold. | |
| | • New `RETIRED_WITHOUT_RECORD`: every RETIRED credit has exactly one retirement item, and the buyer of that retirement owns the credit. | |
| T8 | **PWA.** | |
| | • On a paid order the buyer sees "Retire credits": count or all, reporting period, optional purpose, and a note that the purpose is public. The retirement certificate follows. | |
| | • The order's credit list marks retired credits. | |
| | • The buyer's marketplace summary shows purchased, retired and still-held counts (backlog S9.6, minimal). | |

## 2. Failure modes

| Failure | Required behaviour | Test |
|---|---|---|
| The same request sent twice, or concurrently | One retirement, the same certificate | PGlite + pg race |
| Two requests retire overlapping credits concurrently | Each credit is retired once. The later request gets 409 `CREDIT_NOT_RETIRABLE` and nothing partial. | pg race |
| Retiring another buyer's credits, unpaid or unsold credits, or credits already retired | 404 or 409. Nothing is written. | PGlite |
| A count larger than the order's remaining SOLD credits | 409 `NOT_ENOUGH_CREDITS`; nothing is retired | PGlite |
| A retired scenario | 409 `SCENARIO_RETIRED` | PGlite |
| Retirement by direct SQL without a record | The database refuses it | PGlite |
| Purpose containing markup or a long string | 400 (schema) | PGlite |
| Certificate edited in the database | Verification reports "altered" (as in doc 24) | PGlite |

## 3. Build sequence
1. Migration `0012`:
   - the retirement tables;
   - `demo_certificates.kind`;
   - the retirement trigger;
   - the invariant changes.
2. Retirement service and routes, the retirement certificate, and the live retired counts in public verification.
3. pg races.
4. PWA (retire form, retirement certificate, retired markers and counts).
5. Mutation checks, a live smoke and a browser check.

## 4. Open questions (defaults apply unless changed)
1. Reporting periods are limited to `FYyyyy-yy` and `yyyy` (T1).
2. The purpose is public free text limited to 120 safe characters, with no review (T1).
3. A retirement draws on one order when retiring by count. Retiring across orders requires explicit credit ids (T1).

## 5. Decisions made while building
- **Retirement certificates have their own table**, `demo_retirement_certificates`, keyed by retirement id. This replaces the `kind` column on `demo_certificates` planned in T4 and §3, whose primary key is the order id.
  - Each certificate table keeps one simple key and its own number format: `GC-DEMO-…` or `GC-RETIRE-…`.
  - The content carries `kind: 'RETIREMENT'`, so a printed or verified certificate still says what it is.
  - The public route `/api/v1/certificates/:number` and `verify.html` accept both formats and look in the matching table.
- **Ownership means a ledger row.** A credit belongs to a buyer when it has a ledger row in one of that buyer's FULFILLED orders. Another buyer's credit, and an unsold credit, are answered with 404, exactly like a missing one.
- **Database guards, in addition to the service checks:**
  - an item may only name a SOLD credit bought, through a FULFILLED order, by the buyer who retires it;
  - a retirement must have exactly the declared number of items, checked at commit;
  - SOLD → RETIRED needs the credit's retirement item;
  - retirements are refused in a retired scenario.
- **`RETIRED_WITHOUT_RECORD` checks both directions.** A RETIRED credit must have a record, and a credit with a record must be RETIRED and owned by the retiring buyer. `REFUND_WITH_SALE` counts RETIRED credits too.
- **Validation.** The route schemas answer malformed input with 400: period, purpose (`^[A-Za-z0-9 ,.()&:/'-]{1,120}$`), count from 1 to 100, and credit ids (at most 100, unique). The service checks the same rules again, plus that an FY period names consecutive years, also with 400.
- **Responses and screens.**
  - A replay returns 200 with `replayed: true`. The same request id with a different body returns `KEY_REUSE` (409).
  - `GET /retirements` returns the buyer's retirements and its totals: purchased, retired, and still held.
  - Purchased and sold counts in inventory include retired credits, and the order view marks each retired credit.
- **Audit.** Each retirement writes `market.credits.retired`, anchored to the case of the lowest retired credit's active hold.
- **PWA.**
  - A paid order shows "Retire credits". The count defaults to all credits still held, and the reporting period defaults to the current Indian financial year, read in IST. The form says the purpose is shown publicly.
  - A retry reuses the request id until the form changes.
  - The buyer sees purchased, retired and held totals, and a list of retirement certificates.
  - `verify.html` shows retirement certificates, and for a purchase certificate how many of its credits were retired since.

## 6. Validation (2026-10-29)
- **Tests written first and seen to fail:**
  - API: `test/retirement.test.ts` (6 tests) and `test/pg/retirement-races.test.ts` (2 races).
  - Web: `test/retirements.test.ts` (5 tests).
- **Suites:**
  - API 217/217 and real PostgreSQL 27/27 (none skipped).
  - Web 26/26, and the static build succeeds.
  - `guards.test.ts` previously retired a credit with a bare `UPDATE`. That is now refused (T2), so the test asserts the refusal and sets aside only the record trigger to keep testing the lifecycle guard.
- **Mutation checks: 35 of 36 killed.** They cover:
  - every database guard;
  - each service rule: lock, replay, `KEY_REUSE`, ownership, paid order, SOLD only, counts, period, purpose, audit, hash and buyer scoping;
  - each invariant change, inventory, the order view, live retired counts, the route pattern, and the scenario lock in the race.
  - The survivor is the per-credit row lock. It is redundant while the scenario lock serialises every retirement, and is kept as a second layer.
- **Live run** (throwaway database, API, worker and built PWA):
  - The HTTP flow: sale, retirement with a `GC-RETIRE` certificate citing the purchase certificate, and an identical replay.
  - The refusals: `NOT_ENOUGH_CREDITS`, 400 for a bad period or markup in the purpose, and 403 for the presenter.
  - Public verification: intact, matching hash, buyer withheld. A purchase certificate shows `retired {2 of 3}`.
  - Totals 5/2/3, and no market or payout invariant violations.
  - Logs: 135 info lines, no warnings or errors. The database was dropped afterwards.
- **Browser** (signed in as the buyer):
  - The totals and retirement list, retired markers on credits, and "N retired" on the order.
  - Markup in the purpose keeps the button disabled and marks the field invalid.
  - The FY default is FY2026-27, and retiring 1 credit through the form opens the retirement certificate and updates the totals.
  - `verify.html` reads "Genuine" for the retirement certificate and shows the retired line on the purchase certificate.
  - No horizontal overflow at 375 px.
  - A singular "1 demo credit" fix to both certificate kinds came out of this check.
- **Not verified:**
  - Printing a retirement certificate to an actual PDF. It uses the same `.certificate` print rules checked in doc 24.
  - The embedded browser refused to register the service worker, although `sw.js` is served with status 200. The service worker is unchanged by this slice; check it in a real browser.

