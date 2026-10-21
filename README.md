# GreenChain MVP

First implementation slice of [the public demo plan](docs/13-public-demo-plan.md): synthetic showcase, presenter sessions, local capture queue, durable API capture, audit event and transactional worker job. This is a foundation, not the completed farmer-to-buyer MVP.

## Quick preview without Docker

```powershell
npm ci
npm run demo:api
# In another terminal:
npm run build -w apps/web
npm run preview:web
```

Open http://localhost:3000. The development-only fallback uses persistent embedded PostgreSQL in `.local/demo-postgres`. Its generated presenter password is in `.local/presenter-password.txt`; this directory is excluded from source control. It serves the same application handlers, preserves records across restart and runs its audit/proof worker in process. It has no PostGIS; capture delivery jobs remain queued. Use the Docker setup for full infrastructure checks and hosting preparation.

The built preview includes the service worker; `npm run dev:web` is for editing and does not register a new offline shell. Production hosting must serve `sw.js` without long-lived caching. Private API responses are never placed in the shell cache.

## Onboarding and offline check

1. Open the built preview while connected. Wait for **App ready for offline reload**.
2. Sign in as Field agent / presenter. Continue through Farmer, Plot & practice, Evidence, then Consent & review. Use the sample boundary and sample-image buttons for a quick synthetic demo.
3. Reload mid-draft to confirm the step and entered details return. Disconnect the network, then reload again. The cached app shell and remembered local workspace should reopen; new server authentication remains unavailable offline.
4. Complete the invented record and save it locally. It appears as **Waiting to sync**. Connect and sign in again if required, then select **Sync pending captures**.
5. Confirm **Server acknowledged**, refresh, then sign out. Sign-out requires a server response, hides the local workspace, and retains device drafts for the same account's next login.

Use **Install app** or your browser's installation / Add to Home Screen option. An update is offered separately; save your draft before selecting **Load update**. Do not clear browser site data with unsynced records. Persistent browser storage can still be evicted, so server acknowledgement is the durable confirmation.

## Local setup

Use Node 22.14+ and Docker Desktop running Linux containers.

```powershell
npm ci
Copy-Item .env.example .env
# Edit .env: set distinct DEMO_PRESENTER_PASSWORD, DEMO_VERIFIER_PASSWORD and DEMO_BUYER_PASSWORD (16+ characters),
# plus an independently generated 32-byte base64url AUDIT_HMAC_KEY shared by API and worker.
docker compose up -d
npm run db:setup
```

In three terminals:

```powershell
npm run dev:api
npm run dev:web
npm run worker
```

Open http://localhost:3000. The API runs on http://localhost:4000. Public visitors see only seeded showcase captures. Sign in using the password set during initial setup, save an invented plot, then sync it. Refresh to confirm server persistence. Setup is repeatable and preserves existing captures and the original password.

### Database migrations

The schema is versioned SQL in `apps/api/migrations/NNNN_name.sql`, applied in order by `npm run db:setup` (or on its own with `npm run db:migrate -w apps/api`). Each run is one transaction behind an advisory lock, so two hosts starting together are safe and a failed migration changes nothing. Applied files are checksummed: editing one after it ran is refused, so a schema change is always a **new** numbered file. A database created before migrations existed (all expected tables present, no history) is recorded as already at `0001` and then brought up to date; a half-built one is refused with `LEGACY_SCHEMA_INCOMPLETE`. A database newer than the code (`MIGRATION_UNKNOWN_APPLIED`) is also refused. Migrations are forward-only; take a backup before applying one to anything that matters. `CREATE INDEX CONCURRENTLY` and other non-transactional DDL are not supported by the runner.

### Worker operations

`npm run worker` runs the audit chainer and proof worker. It logs structured JSON (pino; secrets, RPC URLs and raw error messages are never written, only safe error codes), never exits on a failed cycle (it backs off up to 30 s and carries on), and stops cleanly on SIGINT/SIGTERM. A read-only endpoint on `127.0.0.1:4100` serves `GET /healthz` (200 healthy/starting, 503 when no cycle completed within `HEALTH_MAX_AGE_SECONDS` or audit integrity failed) and `GET /metrics` (Prometheus text: cycles, proof counts by status, oldest unfinished proof age, audit lag/pending/integrity, full-verification age). It has no authentication: keep it on loopback or behind network controls. Each cycle also writes a `worker_heartbeat` row.

Failed proof steps retry with capped exponential backoff and jitter. A proof that never produced a signed transaction is parked as `FAILED` after `PROOF_MAX_FAILURES` consecutive failures; a proof that has a signed transaction is never abandoned (it stays `RECONCILING`) because it may still land. Operators inspect and retry with:

```powershell
npm run proofs -w apps/api -- list
npm run proofs -w apps/api -- requeue <eventId> <operator-name>
npm run audit:verify -w apps/api      # full re-verification of the audit chain (slow on large logs)
```

Tuning (all optional): `PROOF_MAX_FAILURES` (8), `PROOF_RETRY_BASE_SECONDS` (30), `PROOF_RETRY_MAX_SECONDS` (900), `PROOF_POLL_SECONDS` (30), `PROOF_CALL_DEADLINE_MS` (45000), `PROOF_LEASE_SECONDS` (90; must exceed the call deadline by 15 s), `AUDIT_FULL_VERIFY_HOURS` (24, 0 disables), `HEALTH_MAX_AGE_SECONDS` (120), `WORKER_OPS_PORT` (4100, `off` disables), `WORKER_OPS_HOST` (127.0.0.1), `LOG_LEVEL`.

The browser API URL defaults to localhost:4000. For hosting, set `NEXT_PUBLIC_API_URL` before the web build. Set `WEB_ORIGIN` to the exact frontend origin and `COOKIE_SECURE=true`; use HTTPS and a same-site frontend/API deployment. If the API sits behind a reverse proxy or CDN, set `TRUST_PROXY` to the number of trusted proxy hops (1–5); otherwise every visitor shares the proxy's address and the login limiter locks everyone out together. Leave it unset when the API is reached directly, so forwarded headers cannot be spoofed. No hosting resources have been provisioned.

### Buyer purchase (demo)

`db:setup` (and `npm run demo:api`) seeds a demo market in the presenter scenario: 20 synthetic farmer groups with 10 demo credits each and a flat demo price, plus a `buyer` account. Sign in with `account: "buyer"`. A buyer sees pseudonymous group labels, counts and provenance ids, never farmer names or villages. The flow: `GET /api/v1/market/inventory`, `POST /api/v1/orders` `{requestId, quantity}` (idempotent per request id; a shortfall returns an offer you can accept with `POST /orders/:id/accept-partial`), `POST /orders/:id/payment-attempts` `{acceptSnapshotHash}` (the order's `snapshotHash`), then payment events arrive on the signed webhook `POST /api/v1/payments/webhooks/simulator`. Reservations last 5 minutes (15 once payment is pending, never more than 30). A buyer may hold at most 3 open orders and 10% of supply (so about 20 credits with the seed).

With `DEMO_MODE=true` the presenter (agent account) drives the simulated provider: `POST /api/v1/demo/orders/:id/simulate` with `outcome` one of `pending`, `success`, `failure`, `replay` (resend the last event byte-for-byte; the ledger does not change), `double_charge`, `late_success` or `refund`. Every outcome goes through the same signed-webhook handler a real provider would use. All money is integer paise; tax is a recorded zero demo rule. Nothing here is real settlement or a recognised credit. Details and failure handling: [docs/22](docs/22-demo-buyer-purchase.md).

The local demo creates `.local/buyer-password.txt` and `.local/payment-webhook-secret.txt` once and always runs with simulated payments on.

### Integration tests on real PostgreSQL

`npm test -w apps/api` uses in-process PGlite (one connection), which is fast but cannot show races between connections. `npm run test:pg -w apps/api` runs `apps/api/test/pg` against a real server with parallel connections: the evidence-upload quota (34 concurrent 2 MiB reservations admit exactly 32), competing and replayed calculation approvals (one batch), signer-lease claim and expiry fencing, concurrent audit appenders and chainers, and concurrent migrators. Each test file creates and drops its own throwaway database.

```powershell
docker compose up -d db                 # if host port 5432 is taken, first pick a free one, e.g. $env:GREENCHAIN_DB_PORT = '55432'
$env:TEST_DATABASE_URL = 'postgres://greenchain:local-demo-only@127.0.0.1:5432/postgres'   # use the same port as above
npm run test:pg -w apps/api
```

An unset `TEST_DATABASE_URL` fails the suite on purpose. The URL needs permission to create databases; use only a server where that is acceptable.

## Verification

```powershell
npm test
npm run typecheck
npm run build
```

API integration tests run against embedded PostgreSQL (PGlite) without Docker. They cover durable capture/audit/job transactions, replay and changed-payload rejection, onboarding validation, isolation, origin/CSRF checks, login throttling, expiry and logout. Frontend tests cover offline shell fallback, private-response cache exclusion, legacy IndexedDB migration, draft reopen, owner isolation and interrupted sync. These do not replace checks on real devices, the deployed PostgreSQL/PostGIS server or concurrent connections.

## Current limits and next slice

- The frontend is a static Next.js export. Device captures use IndexedDB, retain stable IDs, and are marked synced only after server acknowledgement. Permanent input/replay errors are shown as rejected; transient failures stay pending.
- The built PWA includes installation metadata, PNG icons and a versioned service worker for offline reload after the initial download. The guided onboarding draft survives reload and stores preferred language, district/village, declared area/right, crop/season and versioned demo consent.
- A remembered presenter identity allows local capture when the API is unavailable. This marker grants no API permission; sync checks the current server session and owner. Sign-out hides device records without deleting them. This demo remains intended for one presenter on a private device; browser storage is not an encrypted multi-user vault.
- The field/evidence slice adds boundary drawing and coordinate entry, server geometry validation and spherical area calculation, offline image blobs, resumable checksummed uploads and separate mandated reviewer decisions. The small demo stores images in PostgreSQL. Details and limits: [document 18](docs/18-field-evidence-review.md).
- Phone OTP, device signing, cross-plot overlap checks, cadastral/rights attestation, object storage/media workers, translations and cursor pagination remain pending. Language selection is a communication preference; consent text is English.
- Geometry is a spherical estimate; land rights and identities are declarations. Evidence approval does not verify a carbon calculation or issue credits. All proof images must be synthetic.
- Audit events now use HMAC records and a committed hash chain with database mutation guards. The local demo runs its audit/proof worker automatically; standalone PostgreSQL API/worker need the same persistent `AUDIT_HMAC_KEY`. Separate database grants remain a hosting requirement.
- Schema setup uses repeatable creation for the first version. Versioned migrations and least-privilege API/worker database grants are required before hosting. No public reset endpoint exists.
- Demo calculations are available from agent case cards and read-only in verifier detail. Select a fixture scenario to see the methodology, assumptions, gross/net tonnes, confidence and buffer. [Calculation notes](docs/19-demo-calculations.md).
- Exact calculation review and gated demo issuance are now available. A separate verifier approves the current saved candidate; one transactional batch records whole-tonne demo credit IDs, buffer and fractional carry. [Review/issuance notes](docs/20-demo-review-issuance.md).
- The Solidity provenance registry and asynchronous Polygon Amoy adapter are implemented. Proofs stay queued until RPC, deployed contract/code hash and server signer configuration are supplied. [Audit/proof setup and limits](docs/21-demo-audit-chain.md).
- Next work: buyer allocation and simulated payments, then ledger/payouts and certificates.

Never enter real farmer identities, phone numbers, bank details or documents into this demonstration.

## Verifier demo

Sign out of the agent workspace and select Institution verifier. The local verifier password is in `.local/verifier-password.txt`. Open a submitted case, review both proof previews and the boundary, enter a reason, then approve demo evidence or reject the case. The separate account role and institution mandate are enforced in the API. A case missing a boundary or complete proof cannot be submitted or approved.

## Calculation smoke

With the local services running and an evidence-approved case present, run `node scripts/demo-calculation-smoke.mjs`. It creates or replays one synthetic standard result and checks request deduplication, changed-key rejection and verifier read-only access. The result never creates credits.

## Issuance smoke

Run `node scripts/demo-issuance-smoke.mjs` with local services available. It creates one fresh synthetic case, uploads sample proofs, approves evidence, calculates and independently approves the exact result, then checks two unique demo credits, buffer/carry conservation and duplicate protection. It reads local passwords without printing them. The local worker chains the audit and queues its proof. Run `node scripts/demo-audit-smoke.mjs` to check the saved chain and proof intent. Without Amoy configuration, no blockchain request is sent.
