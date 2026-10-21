# MVP implementation progress

Started 2026-10-14 against the synthetic public demo scope in document 13.

## First slice

- Static Next.js workspace with responsive layout and synthetic read-only showcase.
- Fastify API with opaque hashed sessions, password hashing, origin/CSRF checks and bounded login attempts.
- PostgreSQL schema with separate public/presenter scenarios, durable captures, audit events and transactional jobs.
- IndexedDB metadata capture queue and explicit sync acknowledgement; duplicate IDs replay and changed payloads conflict.
- PostgreSQL worker skeleton and local PostGIS Compose service.
- Embedded PostgreSQL integration checks and run instructions.
- Persistent embedded PostgreSQL local preview fallback while Docker is unavailable; same API handlers, no PostGIS or separate worker.

## Checks completed

- Six API integration tests passed against embedded PostgreSQL: replay, rollback, scope isolation, authorisation, CSRF/origin checks, expiry/logout and login throttling.
- Both workspaces passed TypeScript checks and production builds; Next.js exported static pages successfully using webpack.
- Dependencies are pinned with a package lock; initial install audit reported no known vulnerabilities.
- Frontend preview served HTTP 200 and was visually inspected in the browser.
- Live local API smoke passed: showcase fixtures, presenter login, capture/replay, private/public isolation, logout and revoked-session denial. Captured data survived an API restart.

## PWA and onboarding slice

- Static manifest, 192/512 PNG icons, standalone installation metadata and an install/help control.
- Build-generated service worker precaches 27 shell assets under a content version; offline root navigation falls back to the installed shell. API/session responses and external origins are excluded. Updates require an explicit activation action.
- Three-step farmer → plot/practice → consent/review form. Each edit and step is persisted in IndexedDB under the presenter identity; saving creates a stable capture event and queues it for sync.
- Existing device captures migrate to an owner-scoped queue. Server acknowledgement is distinct from local save. Transient failures remain pending; rejected events do not stop valid neighbours.
- API stores validated versioned onboarding details and fingerprints them canonically. Legacy capture fingerprints continue replaying correctly. Claimed rights, declared area and identity are explicitly unverified.
- Login adds password visibility and clearer failures; server sessions are checked before sync. A remembered identity restores only a local workspace when offline, never API privileges. Logout hides local records and retains drafts.
- Direct HTTP checks passed for the served manifest, PNG icons, all precache assets and full onboarding persistence. Browser security policy blocked automated inspection of the existing tab, so real browser/device install and cold offline reload checks remain manual; use the README walkthrough.
- Final checks: seven API integration tests and four frontend worker/storage tests passed; both workspaces passed type checks, and the updated static PWA production build passed.

## Field evidence and reviewer slice

- Four-step onboarding now captures a polygon and two synthetic proof images before consent v2/local save. Shared geometry validation checks ring shape/ranges/intersections and the API calculates spherical area separately from declared area.
- IndexedDB stores scoped image blobs and stable hashes/IDs. Sync resumes acknowledged 256 KiB chunks, checks content/hash/type and submits only after both proof slots are complete.
- Separate verifier account with scenario/institution mandate; private scope-checked proof previews, queue, expected-version decisions, reason and immutable evidence snapshot. Self-review and agent decisions are prohibited. Submitted inputs are frozen.
- Full automated run passed: nine API integration tests, five browser-storage/worker tests and two shared geometry tests. All workspace type checks and the final single-worker production build passed. The live-service smoke created a synthetic case and verified boundary replay, resumed proof chunks, validation, submission, role checks, private previews and immutable review. The final served PWA and all 27 cache assets passed HTTP checks.
- See [document 18](18-field-evidence-review.md) for exact demo limits. The user's manual browser/offline test is deferred by request. Calculation verification and issuance remain next steps.

## Demo calculation slice

- Explicit synthetic namespace, methodology and parameter version. Four immutable fixture scenarios are linked to an approved evidence snapshot and server-computed polygon area.
- Fixed-scale BigInt arithmetic with half-even rounding reproduces document 08's placeholder example. Gross, confidence, buffer, net, flags and intermediate trace are stored; low-confidence runs contain no carbon quantity.
- Stable request receipts and canonical input hashes deduplicate retries. The API checks agent ownership, explicit namespace eligibility, approved case version and unchanged evidence. Verifiers can read only; inputs/results cannot be overridden by the request.
- Agent case cards and verifier detail show saved runs, assumptions, confidence weights, evidence decision, input fingerprint and result history. No registry, carry-over, calculation-review decision or chain job is created.
- Details: [document 19](19-demo-calculations.md). Manual browser/PWA verification remains deferred at the user's request.
- Validation: 19 tests passed, final type checks/build passed, targeted calculation/scope safeguards passed, and live persistence/replay/verifier-read checks passed. All 27 served PWA cache assets were available.

## Calculation review and demo issuance slice

- Verifier decision pins the exact immutable calculation, input hash and candidate generation. New results or explicit candidate changes invalidate stale review attempts. Creator self-review and agent approvals are denied.
- Approval calls an internal registry port in the same transaction. One batch per case records whole-tonne demo credit IDs, buffer and source-linked fractional carry; quantities reconcile under SQL checks. Replays and competing approvals create one effect.
- Rejection/Needs-visit outcomes do not issue. Once approved, new calculations/candidate changes cannot issue again. Reviews and batches are immutable, and composite provenance keys prevent cross-case linkage.
- Durable registry outbox events prepare the later proof worker; no on-chain mint or anchor has occurred. Agent/verifier screens show the recorded basis, unit IDs, buffer/carry and proof-pending status.
- Details: [document 20](20-demo-review-issuance.md). Manual device tests remain deferred by request.
- Validation: 23 tests, final targeted provenance checks, workspace type checks and production builds passed. A live synthetic case issued two unique demo credits with 0.3268 t buffer and 0.9412 t carry-over; duplicate review and competing-basis protection passed. The proof event is durable but not submitted on-chain.

## Audit and Amoy proof slice

- New business events use HMAC-SHA256 signed records with keyed pseudonyms and minimal reference fingerprints. A transaction-held state lock fences immutable SHA-256 links and committed sequence numbers. Historical events are explicitly labelled as backfilled.
- Scoped audit verification checks MACs, metadata, links, head state and locally recorded confirmed anchors. Database triggers guard audit rows, links, outbox intents and prepared proof jobs; separate role grants remain part of hosting preparation.
- Each approved issuance queues an immutable batch commitment and audit anchor. The Amoy adapter pins network/contract runtime code/version/writer, restricts calldata/value/gas/fees and persists signed bytes/hash/nonce before send. Unknown outcomes reuse the durable transaction; confirmation checks and recurring canonical-block checks handle reorganisation or RPC uncertainty.
- The actual Solidity registry passed local EVM deployment tests for writer enforcement, duplicate/conflicting effects, confirmation depth, reorganisation recovery and signer policy. Twenty API tests, five PWA storage/worker tests and two geometry tests passed, with final targeted guard/fingerprint checks also passing. The test runners use serial execution and reduced V8 thread usage for this machine.
- Agent/verifier issuance detail shows proof configuration/pending/confirmed states, actual Amoy transaction links when available, integrity/head details and a readable case event history. [Document 21](21-demo-audit-chain.md) records setup and operational limits. No Amoy credentials or deployment were supplied; no external blockchain transaction has been sent.
- Final workspace type checks and production builds passed. Live issuance/audit checks confirmed two unique demo units, 11 newly signed case events and a queued proof intent; the 33-event chain (22 historical backfills) remained verified after restart. The updated PWA and all 27 precache assets are served on localhost.
- Next product slice is buyer allocation and simulated purchase/payment, followed by ledger/payouts and certificates. Manual phone/PWA checks remain deferred by request.

## Audit hardening slice

- Versioned migrations replace the re-run schema statements (legacy databases are baselined automatically as `0001`). New guards: `review_decisions` are immutable, `demo_credits` follow an enforced status-transition graph, and a proof's `status` must match its columns (CHECK).
- Audit verification is incremental from a stored checkpoint (cost proportional to new events, no 10,000-event ceiling), takes no part in the request path or the chaining transaction, and case audit responses no longer expose global sequence, head or counts. A full streamed re-verification runs on a schedule and on demand.
- The worker logs structured JSON, exposes `/healthz` and `/metrics`, writes a heartbeat, survives pool and cycle errors, and retries failed proofs with bounded backoff into a `FAILED` state that an operator requeues.
- Real-Postgres suite (`npm run test:pg`, compose database, throwaway database per file) covers the upload-quota race, competing approvals, lease claim/expiry fencing, concurrent chainers and concurrent migrators. Removing the scenario lock from `beginUpload` or the expiry check from `claimSigner` makes the matching test fail, so the races have teeth.

## Buyer purchase slice (in progress)

- Spec: [document 22](22-demo-buyer-purchase.md), design-reviewed and approved. Build steps 1-5 are implemented: schema and database guards (migrations `0005`, `0006`), FCAE v0 allocation and half-even commission, the order service (scenario lock, reservations, shortfall offers, reaper), payments (signed webhook with every decision branch, refunds, deterministic simulator), and HTTP routes with a seeded buyer account and a 20 x 10 demo market.
- Validation (after step 5): 111 PGlite tests and 15 real-PostgreSQL race tests pass; the races and key guards were mutation-checked (removing the lock, the event-recording order, the same-attempt or mismatch branch, or the active-hold index turns the matching test red). A live smoke against a throwaway database ran the full journey (inventory, 20-credit order, payment, replayed callback with an unchanged ledger, forged webhook rejected); the server log had no errors and no secrets.
- Step 5: the worker sweeps the market (reaper backstop, delayed refund settlement, scheduled invariant check with a violation gauge) and exports market gauges; the API counts webhook and order outcomes and scenario-lock waits on an optional loopback metrics port. A live run of API and worker against a throwaway database expired a lapsed order within seconds; both logs were clean and secret-free.
- Remaining: buyer screens (step 6).

## Remaining release work

This does not complete week 1 or the public release gate: hosted staging, deployed PostgreSQL checks, phone OTP, production role/device policies, versioned migrations, private object storage, cross-plot spatial checks and operational hardening remain. Offline shell behaviour is implemented and covered by automated worker/storage tests; real-device verification is still pending. Evidence approval does not make a credit or MRV/calculation-verification claim.

Use document 13 as the sequencing baseline; production requirements remain in the existing design documents. Updated supported dependency versions are resolved during scaffold setup and recorded in package-lock.json; static export and monolith architecture remain unchanged.
