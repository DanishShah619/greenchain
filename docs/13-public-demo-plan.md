# GreenChain public demo plan

Prepared 2026-10-11. User target: a public link in approximately one or two months. This is a proposed delivery scope for a synthetic-data demonstration, not a revision to the production requirements or a claim of scientific validation. Scientific validation work is deferred for this demo.

## Outcome

A presenter can complete the farmer-to-buyer journey through a hosted web app: capture a farmer and plot offline, sync evidence, review a labelled demonstration calculation, approve demo credits, allocate an order, simulate payment, show an earnings statement and simulated payout, and download a certificate. A short failure scenario demonstrates that duplicate payment callbacks do not create duplicate earnings.

The folder currently contains specifications and a calculation script, not an application implementation. The immediate priority is a running vertical slice with persistent data.

## Critical issues and delivery decisions

| Priority | Persistent issue | Demo approach | Completion evidence |
|---|---|---|---|
| P0 | No executable end-to-end product | Build one flow through UI, API, database and worker before expanding features | Hosted link completes the journey; a refresh preserves server state |
| P0 | Workflow modules disagree on state or ownership | Fix one contract for verification, issuance, reservations, fulfilment and ledger posting; every credit points to its reviewed calculation | An order and each credit can be traced back to its plot; illegal transitions fail |
| P0 | Retries or concurrent buyers corrupt credits/money | Use transactions, unique constraints, idempotency keys and the transactional job queue from the design | Duplicate issuance/callback/job produces one effect; concurrent orders never sell a credit twice |
| P0 | Public visitors alter presenter data | Public visitors get a read-only synthetic showcase; presenter authenticates into a separate scenario; authorisation enforced in API | Viewer cannot mutate or reset a presenter scenario, including by direct API request |
| P1 | Offline capture appears successful but loses data | IndexedDB queue, stable event IDs, status per record, resumable media; remove records only after durable server acknowledgement | Capture, reload offline, reconnect and retry without loss or duplicate records |
| P1 | FCAE cannot fill small-pilot orders under its own caps | Seed enough verified payee groups; account for supply, per-order cap and reservation quotas when preparing scenarios | Allocation explains weights, caps and shortfall; no undocumented relaxation |
| P1 | External services fail during presentation | Deterministic demo adapters for payment, payout, KYC and notifications; chain proof optional and asynchronous | The complete demo runs without external credentials; failed proof/notification does not roll back fulfilment |
| P1 | Deployment and demo state cannot be reproduced | Early staging deploy, migrations, versioned seed, protected reset, health checks and smoke checks | A fresh environment reproduces the scenario; reset only affects its explicit demo namespace |

Use the proposed modular monolith, PostgreSQL/PostGIS and static frontend architecture. For the demo implementation, use Fastify as the default Node/TypeScript API framework; retain a worker from the same codebase and PostgreSQL-backed jobs. This is a demo default, not sign-off on outstanding production ADRs. Pin supported dependency versions during scaffold work.

## Real behaviour and simulated integrations

Implement real persistence, role checks, offline queueing, sync deduplication, reviewed-calculation linkage, deterministic FCAE, reservation expiry, payment state transitions, append-only earnings, balanced accounting postings for the implemented events, and certificate download. The demo must not claim live settlement or recognised carbon issuance.

Supply synthetic calculations only through an explicitly demo-only methodology and registry namespace. Production gates that prohibit issuance from fixture inputs remain intact. Label the demonstration calculation and credits in the product. Mock KYC should test workflow only and accept no real bank or identity data.

Payment simulation must exercise success, failure, duplicate callback and late success through the same application handlers used by an adapter. A late success rechecks ownership and either fulfils or refunds. Payout simulation must resolve unknown outcomes by key before retrying. Monetary values are integer paise; statements expose gross, commission and net. Use an explicit demo tax configuration with no implication about actual tax treatment.

Keep full retirement as a secondary flow. Keep one dispute/freeze/reversal path only if the core flow is stable; avoid arbitrary ledger editing. Daily payout batching can use a protected demo clock so maturity/rollover scenarios do not require waiting days. Record simulated time explicitly.

## Public hosting requirements

- Static frontend over HTTPS, API service, worker, persistent PostgreSQL/PostGIS and object storage. Select hosting after checking the budget and available accounts; do not promise free hosting or provision billable services without authorisation.
- Synthetic data only. Demo media must not identify real people. No real OTP, Aadhaar, bank, UPI or land-record submission is needed.
- Seeded presenter accounts with server-side sessions and server-enforced roles. Cookies, CORS, secrets and endpoints must be configured for the deployed domains. Show users the demo role flow without exposing backend credentials.
- A read-only public showcase and an authenticated interactive presenter scenario are the first release. Self-service isolated visitor sessions are optional later scope; do not expose a shared editable dataset with a public reset.
- Reset requires presenter/admin access and is scoped to the demo scenario. Test the same isolation on media, certificates, jobs and API routes.
- Logs and error visibility, dependency readiness checks, backups, a tested deployment command and a presentation runbook. Schedule/reset controls are protected API commands, not public URLs.

## Four-week critical path and optional extension

| Window | Work | Exit gate |
|---|---|---|
| Week 1 | App scaffold, migrations, seeded roles/data, hosted staging, basic API/worker, smoke check | Public HTTPS link loads; authorised writes persist; unauthorised writes fail |
| Week 2 | Agent capture/outbox, upload, sync, verifier review, demo calculation and issuance | Offline-to-verified-inventory journey works after reload and retry |
| Week 3 | FCAE, orders/reservations, payment simulator, earnings/journal, simulated payout and statement | Purchase flow works; duplicates, contention and late success preserve invariants |
| Week 4 | Certificate, safe reset, public showcase, end-to-end checks, presentation polish and runbook | Fresh seed completes a rehearsed demonstration on the deployed environment |
| Weeks 5–6 if available | Retirement, one dispute/reversal path, failure controls, low-end Android checks and accessibility polish | Secondary paths work without destabilising the core |
| Weeks 7–8 if available | Research comparison screen, optional Razorpay sandbox or Amoy proof, deployment rehearsal and fixes | Optional integration outages do not prevent the core demonstration |

These are sequencing targets, not a capacity-backed commitment: team size and measured velocity are still unknown. If progress slips, reduce secondary screens/integrations before weakening persistence, authorisation or financial invariants. Introduce end-to-end verification from week 1; do not reserve testing for the last week.

## Seed and presentation scenarios

The ordinary allocation scenario can start with 20 distinct verified payee groups holding 10 available demo credits each, priced with complete demo rules. A 20-credit order fits the documented per-buyer supply limit, per-group reservation quota and allocation cap. Prepare expiry and contention scenarios with their initial state specified; check all quotas rather than silently overriding them. Track existing reservations and available supply when calculating whether another order is allowed.

The main presentation should take approximately 8–10 minutes: demonstrate offline capture and reconnection, approve the reviewed result, browse inventory, show the allocation explanation, simulate payment, resend its callback, compare the unchanged ledger, show payout/statement and download the certificate. A protected reset returns the presenter scenario to its documented starting state.

## Deferred for this demo

Scientific calibration and external expert review; live credit recognition; live payouts and legal policy enforcement; real SMS/DLT; live satellite ingestion; blockchain mainnet; 500K-farmer capacity proof; production privacy-key lifecycle; full financial operations; produce, contract farming, foreign exchange and donations. Basic access control and data protection remain part of the public demo.

## Release gate

The hosted environment passes its core journey from a fresh seed; repeated callbacks/jobs do not duplicate effects; concurrent buyers cannot double-sell; offline reload/retry preserves queued records; viewer permissions hold at API level; certificates and statements reconcile to stored transactions; external adapter failure remains visible without corrupting state; the presenter can recover/reset safely. Record what is simulated in the runbook and product.
