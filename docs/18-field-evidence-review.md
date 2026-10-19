# Field evidence and review demo slice

Implemented 2026-10-14. This extends onboarding through a synthetic evidence-review decision. Carbon calculation, calculation verification and credit issuance are separate next steps.

## Field journey

Sign in as Field agent / presenter. Capture invented farmer/location and plot/crop metadata. Draw corners on the offline grid, enter longitude/latitude corners with the keyboard, or use the synthetic sample boundary. The grid is a schematic with no basemap. Save two synthetic PNG/JPEG images, or use the sample-image button. Review demo consent v2 and save locally. Sync replays metadata/boundary safely, resumes image chunks, validates both proofs and submits the case.

New saves require a valid boundary and both images. Old captures remain readable and replayable; they are not silently supplied with invented proofs. Corrections to submitted, rejected or invalid-evidence cases require a new case and event ID. History is retained.

## Geometry

One WGS84 GeoJSON polygon ring with 3-64 distinct corners plus closure. The configured bounding region is longitude 68-98, latitude 6-38. Reject non-finite/out-of-range coordinates, open rings, crossings, duplicate corners, double-back segments and area outside 0.01-10,000 ha. A shared browser/API validator uses Turf spherical area, stored by the API to four decimal places separately from declared area. This is a spherical estimate, not cadastral measurement or spheroid/PostGIS certification. The rectangular region is not a country-border check. Cross-case overlap detection, GPS uncertainty and institution rights attestation remain pending.

## Proof durability and privacy

IndexedDB holds owner/event/slot-scoped blobs with stable upload IDs and original SHA-256 hashes. Images are limited to 2 MiB each. Server-reserved slots accept 256 KiB chunks, return received indexes, deduplicate matching replays and reject changed bytes. Completion requires every chunk, correct total size and hash, PNG/JPEG decoding and at most 12 million input pixels. Metadata is stripped from re-encoded static PNG previews. Preview routes enforce scope/mandate and use `Cache-Control: no-store`. Original bytes are not publicly served.

This bounded demo stores bytes and previews in PostgreSQL instead of object storage. Validation runs synchronously with bounded input before the final mutation lock. Scenario quotas cap original-plus-preview storage at 64 MiB and 100 slots. Reservation and final quota checks lock scenario before case. Expiry of abandoned uploads, storage adapters, async media workers and stronger workload controls remain hosting work.

## Reviewer contract

Use separate seeded agent (`presenter`) and verifier (`verifier`) accounts. Roles come from server records on every request. Reviewer mandates bind user, scenario and institution. Field agents read/write their own cases; reviewers can only access mandated cases/proofs. Agents cannot decide, and reviewers cannot approve their own capture.

States: `DRAFT -> SUBMITTED -> EVIDENCE_APPROVED | REJECTED`. Full onboarding, valid geometry and both complete proof slots are required for submission. Submitted inputs are frozen. Decisions require expected version, stable decision ID and a 10-500 character reason. Decision, case update, immutable snapshot (onboarding, boundary/area, original proof hashes) and audit append commit together. Matching retries replay; contradictory decisions and later input changes fail. Evidence approval creates no carbon credits.

## Running and checking

Run `npm run demo:api`, build the web workspace and run `npm run preview:web`. Passwords are in `.local/presenter-password.txt` and `.local/verifier-password.txt`. For Docker, set distinct 16+ character presenter/verifier passwords in `.env`. Use **Load update** when offered, saving unfinished work first. The user's manual browser/offline test remains deferred at their request.

Automated coverage includes the complete approval/rejection journey, self-review denial, missing-slot gates, stale versions, chunk resume/replay, invalid image/hash rejection, scope/mandate denial, immutable decisions, IndexedDB blob recovery and spherical-area examples. Embedded PostgreSQL tests do not establish deployed multi-connection race or PostGIS guarantees.

Final results: 16 tests passed, all workspace type checks passed, production build passed and live field-to-verifier smoke passed. Run `node scripts/demo-field-smoke.mjs` from the repository root to repeat the local synthetic smoke; each run creates one synthetic case. It reads local generated account passwords without printing them. The live smoke's proof previews require authentication and its reviewer decision produces no credits.

Implementation sources: [Turf area](https://turfjs.org/docs/api/area), [Turf kinks](https://turfjs.org/docs/api/kinks), [Sharp input limits](https://sharp.pixelplumbing.com/api-constructor/).
