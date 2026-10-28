# Demo purchase certificate and safe presenter reset

Status: **Signed off 2026-10-28 and implemented (all five build steps). §6 records decisions made while building, and §7 the validation.**

Scope: two release-gate items of [13](13-public-demo-plan.md) week 4.
- "Certificates and statements reconcile to stored transactions".
- "The presenter can recover/reset safely": "a protected reset returns the presenter scenario to its documented starting state".

It covers the purchase certificate of PRD FR-CRT-1 and backlog S11.1. Retirement (S11.2) remains deferred to weeks 5–6.

## 1. Purchase certificate

| # | Decision | Reason |
|---|---|---|
| C1 | **One certificate per FULFILLED order.** Its content is built only from stored rows: the order, its ledger rows, the credits and their issuance batches, and each batch's chain proof when it is CONFIRMED. The certificate is issued on first request. Issuing is idempotent, so a second request returns the same certificate. | It reconciles by construction. A worker job and a failure mode (doc 04 F12-1) are avoided, because the inputs never change after fulfilment. |
| C2 | **Stored and frozen.** `demo_certificates(order_id PK, scenario_id, number UNIQUE, content jsonb, content_sha256, issued_at)`. It is insert-only. `content_sha256` is SHA-256 over canonical JSON (sorted keys, no whitespace). The certificate number is random (e.g. `GC-DEMO-7K4Q-9XW2`), not sequential, so numbers cannot be enumerated. | The doc 04 F12-4 tamper check works against stored bytes. |
| C3 | **Content.** It carries the following, and no farmer PII or case ids. | Matches FR-CRT-1 and the privacy rules of docs 22 and 23. |
| | • the "Demonstration — synthetic credits" label; | |
| | • certificate number, issue date, buyer account id; | |
| | • credit ids, quantity and tonnes (1 tCO₂e per demo unit), vintage; | |
| | • unit price, gross total, tax line (DEMO_ZERO); | |
| | • pseudonymous farmer-group labels with a count per group; | |
| | • the chain proof (network, transaction hash) per issuance batch when confirmed, otherwise "proof pending"; | |
| | • content hash and verification URL. | |
| C4 | **Format.** A print-ready certificate page in the PWA, which "Save as PDF" in any browser turns into a file. There is no server-side PDF library. | No new dependency to vet. It is accessible and works the same on phones. A generated PDF can be added later without changing C2. |
| C5 | **Verification by URL.** It is public and unauthenticated: `GET /api/v1/certificates/:number`. | The FR-CRT-1 acceptance criterion: "hash verifiable via URL". |
| | • It returns the certificate content and hash. The buyer account id is replaced by "Demo buyer". | |
| | • With `?hash=…` it also says whether the hash matches. | |
| | • Unknown numbers return 404. Requests are rate-limited per IP, as the webhook route is. | |
| C6 | **Access.** | |
| | • The buyer who owns the order can issue and view its certificate. | |
| | • The presenter can view any certificate in its scenario. | |
| | • Everyone else gets 404, except through the public verification route. | |
| | • Each issue is audited, anchored to a group of the order (`orderAnchor`). | |

## 2. Safe presenter reset

The audit chain is global: one hash chain across all scenarios, with immutable links. Ledger, journal, lot, payout, attempt, rail and audit rows are append-only by design. **A reset therefore must never delete.** Deleting the presenter scenario's rows would break audit verification for every scenario and bypass the guards of docs 22 and 23.

| # | Decision | Reason |
|---|---|---|
| R1 | **Reset by rotation.** The presenter's accounts move to a fresh scenario seeded to the documented starting state. The old scenario stays in place, untouched and read-only to everyone. | Nothing is deleted or rewritten; the audit chain and every invariant hold. The old run remains inspectable by an operator. |
| R2 | **Starting state**, as `setup.ts` seeds it today: | It is the same seed as a fresh install, so rehearsals match the deployed first run. |
| | • 20 synthetic farmer groups × 10 available credits, and the price list; | |
| | • a verifier mandate; | |
| | • the default ledger config (version 0) and the demo clock at 0; | |
| | • no captures, orders or payouts. | |
| R3 | **What moves.** | Doc 13: the presenter, verifier and buyer accounts of one demo scenario. |
| | • The users of the presenter's current scenario: the presenter, the verifier and the buyer, re-pointed with `users.scenario_id`. | |
| | • The verifier mandate is recreated for the new scenario. | |
| | • All sessions of those users are revoked, so everyone signs in again into the clean scenario. | |
| | • Scenario ids are `presenter`, `presenter-r2`, `presenter-r3` and so on. `showcase` is never reset. | |
| R4 | **Retired scenarios.** `demo_namespaces.retired_at` is set on the old scenario. | Money already in flight is still followed to a final state (never abandoned). Old scenarios stop accumulating new work. |
| | • The worker keeps settling payouts already in flight there (send, resolve, settle). | |
| | • No new scheduled batches are created there. | |
| | • Sales and presenter controls on a retired scenario are refused. | |
| R5 | **Protection.** | Doc 13: "reset requires presenter/admin access … protected API commands". |
| | • Presenter only (`requirePresenter`), with CSRF. | |
| | • A typed confirmation (`RESET`) and a `requestId`: a replay returns the same new scenario. | |
| | • It runs under the old scenario's lock, plus a global advisory lock for scenario creation. | |
| | • It is audited in the old scenario, with the new scenario id in the facts. | |
| | • In the PWA it sits behind a confirmation dialog. | |
| R6 | **Isolation tested.** After a reset: | Doc 13 §"Public hosting requirements". |
| | • old certificates still verify by URL; | |
| | • old orders, cases and payouts are invisible to every role; | |
| | • the worker finishes an in-flight payout in the retired scenario; | |
| | • audit full verification passes; | |
| | • the market and ledger invariants hold in both scenarios. | |

## 3. Failure modes

| Failure | Required behaviour | Test |
|---|---|---|
| Two reset clicks, or a replayed request | One new scenario | PGlite + pg race |
| A reset while a buyer's payment is in flight | The order stays in the old scenario. A late success there fulfils or refunds as today and is never lost. | PGlite |
| A reset while payouts are in flight | The worker finishes them in the retired scenario | PGlite |
| The seed fails halfway | The transaction rolls back and the accounts stay in the old scenario | PGlite (fault injection) |
| A certificate requested twice at once | One certificate, the same number | pg race |
| Certificate content edited in the database | Verification by URL reports a mismatch; the row guard refuses the edit | PGlite |
| A guessed certificate number | 404, rate-limited | PGlite |

## 4. Build sequence
1. Migration `0011`:
   - `demo_certificates` with its guard;
   - `demo_namespaces.retired_at`;
   - retired-scenario refusal in the market and payout writers.
2. Certificate service and routes (issue, view, public verify), with tests.
3. Reset service and route, with tests and races; the worker skips retired scenarios for new batches.
4. PWA:
   - a certificate button on fulfilled orders (buyer) and in the presenter's order list;
   - the print-ready page;
   - a reset control with confirmation in the presenter panel.
5. A live smoke and a browser check (including printing to PDF); docs 13 runbook notes.

## 5. Open questions (defaults apply unless changed)
1. Print-to-PDF page now; a server-generated PDF later (C4).
2. Old scenarios are kept indefinitely. A cleanup or export tool is later operator work (R1, R4).
3. The buyer account id shown on certificates is the demo account id (`buyer`); a display company name is later.

## 6. Decisions made while building
- **Retired-scenario refusal sits in two places.**
  - In the database, triggers refuse new orders, payout runs, config versions and clock moves.
  - In the application, `withNewWorkLock` wraps creating an order, accepting a partial offer, starting a payment, moving the clock and adding a config version, and returns `SCENARIO_RETIRED` (409). `requirePresenter` returns the same.
  - Finishing work keeps the plain lock: cancellation, provider events, refunds and the reaper.
  - The worker resumes open payout runs in a retired scenario but never schedules new ones.
- **Namespaces.** `demo_namespaces` is guarded against un-retiring, but not against deletion. Foreign keys already block deleting a namespace that holds data, and an existing test deletes an empty one.
- **Who moves on a reset.** The reset moves every account of the scenario except the seed's reviewer (`marketReviewerId`), which stays with the reviews it signed. Scenario ids are numbered from the highest existing `-rN`.
- **Seeding inside the reset.** `seedDemoMarket` was split into `seedDemoMarketTx`, so the reset seeds inside its own transaction. The Postgres adapter forbids nested transactions, and a failed seed must roll back the rotation.
- **Certificates.**
  - Issued with `POST /orders/:id/certificate` (buyer, CSRF) or `POST /demo/orders/:id/certificate` (presenter), and read with the matching `GET`.
  - A second issue returns 200 with `replayed: true`.
  - A proof that confirms after issue is not added later: the certificate is frozen.
- **The PWA's `verify.html`** is the human-facing verification link. It reads `?n=` and `?h=` strictly and calls the public API. The certificate content keeps the API path.
  - The link names the `.html` file, because the static export writes `verify.html`. Any static host then serves it without rewrite rules.

## 7. Validation (2026-10-28)
- **Tests**, written first and seen to fail:
  - API: certificate domain (3), certificates over HTTP (6), reset (6);
  - web: 3 helper tests, and the boundary check with the reset panel added;
  - real PostgreSQL: concurrent resets, and concurrent first certificate requests.
- **Mutation checks.** All 13 certificate and reset rules are caught, after two test gaps were closed: the seed reviewer stays behind, and a presenter in a retired scenario is refused. Removing the reset's advisory lock fails the reset race in 3 of 3 runs, and removing `ON CONFLICT` from the certificate insert fails the certificate race.
- **Correcting my own expectation.** Repeated requests with one id do not always replay. When a different request rotates the scenario first, they are all refused, which is correct. The race now asserts that repeats of one request always get one answer.
- **Browser check** (built PWA, live API and worker, throwaway database):
  - A buyer issued and printed a certificate. The print rules leave only the certificate, with its buttons hidden.
  - The verify link showed "Genuine", and a wrong fingerprint was reported as not matching.
  - The presenter saw the same certificate number, which confirms that issuing again is idempotent.
  - The reset button stayed disabled until `RESET` was typed. The reset then rotated to `presenter-r2` and signed everyone out.
  - After signing in again: no orders, no payees, clock at 0, and the old certificate still verified.
  - In the database: the old scenario was retired with its order and certificate kept and no accounts left in it; the new scenario held the 3 moved accounts.
  - Logs: 124 lines, all info, no secrets.
- **Not checked here:** printing to an actual PDF file. The embedded browser cannot print; the print rules were checked by applying them on screen instead.
