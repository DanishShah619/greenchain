# F12 Certificates verification and retirement

Owners: `certificates` for documents; `registry` for credit state; `market` for buyer ownership. E11. Purchase certificate core; full retirement secondary; partial retirement deferred if needed. Inherits [common contracts](common-contracts.md).

## Immutable claims and materialisation

`GeneratePurchaseCertificate`, `VerifyCertificate`, `RetireOwnedCredits`, `GenerateRetirementCertificate`. A certificate is an immutable snapshot of persisted credits/order/reporting period and claim type. It is not the source of ownership and does not make a demonstration credit legally recognised. Hash canonical structured content and store template/version/hash with private PDF object. Use an unguessable public verification token mapped to a deliberately limited disclosure view.

FULFILLED event queues generation with unique `(order,certificateKind,version)` effect key. Worker reads owner-port snapshots, builds bounded template, uploads to private storage then commits object reference/hash. Crash can leave orphan file; retry uses stable document identity/content hash and cleans unreferenced output after grace period. Never mark READY before the referenced object is verified accessible. Async chain proof has separate status/attachment, so it need not mutate the signed core claim.

## API and retirement transaction

`GET /orders/:id/certificates` returns owner-authorised jobs/documents. `GET /certificates/:id/download` rechecks access and issues short-lived URL. `GET /certificate-verifications/:token` exposes pseudonymous ID, kind, tonnes, vintage, hash and current validity/reversal notices; omit farmer PII, exact polygon and price unless explicitly public.

`POST /retirements {creditRefs,reportingPeriod,purpose}` checks buyer ownership, SOLD/not frozen state, compatible period and unique effect identity. Lock refs in stable order and retire in one registry transaction with audit/job. A duplicate cannot create a second retirement. RETIRED remains terminal; a later fraud finding is disclosed through reversal/replacement metadata, not deletion of the certificate or restoration to SOLD.

## Security scalability and acceptance

Templates escape text and accept no arbitrary HTML/remote URLs from users. Rendering uses resource/time/page caps and a sandboxed worker. Bound certificate size/credit count; large purchase manifests can be attached rather than thousands of PDF rows. Prevent token enumeration with rate limits; private downloads stay scoped regardless of URL knowledge. Cache public verification only with clear freshness/current-status handling.

Test cross-buyer access, renderer outage, crash between upload/commit, repeated generation, hash verification and concurrent retirement. Public verification must show demo status and invalidation/replacement notices. Certificate creation failures leave the purchase fulfilled and document pending with recoverable job status.
