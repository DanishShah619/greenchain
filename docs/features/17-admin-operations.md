# F17 Administration observability deployment and demo isolation

Owner: `admin` presents read ports; commands execute in the owning module. E15 plus demo controls. Inherits [common contracts](common-contracts.md).

## Admin surface

`GET /admin/invariants`, `/admin/jobs`, `/admin/reconciliation`, `/admin/health-summary` expose bounded authorised summaries. Separate institution admin, finance operator, privacy reviewer and platform operator permissions. No generic SQL endpoint, arbitrary table editor or writable repository under admin. Every correction invokes a named owner command with expected state, reason and idempotency key.

Replay endpoint selects an existing approved job and preserves its original effect key; it cannot edit amounts or transplant scope. Configuration publish uses versioned drafts/reviewer policy. Public liveness returns minimal readiness state, not topology/secrets. Readiness checks dependencies without invoking payment/chain side effects.

## Demo reset and public access

Presenter-only `POST /demo/scenarios/:id/reset {expectedGeneration}` is enabled solely in demo environment. Acquire a scenario maintenance lease, advance generation/fence writers, reject new mutations, stop/park in-flight jobs and wait/reconcile claims before replacing data. All jobs/object manifests contain scenario generation; stale workers cannot write into reseeded state. Keep reset audit outside replaceable scenario rows. Reset cannot cross scenario or delete production/shared objects. Return a reset job status, not immediate success.

Read-only showcase data is distinct from presenter state. Route hiding is not enforcement. Bound demo uploads/request rates, reset attempts and resource lifetime. No real identities/accounts in seeds. Optional visitor-play scenarios require server-issued isolation and cleanup before being enabled.

## Durability and rollout

API/worker use same domain build but independent resources; one migration runner owns schema changes. Expand/contract changes stay compatible with queued event versions and rollback; destructive migrations require a separately reviewed operation. Secrets differ per environment. Traces carry request/event correlations; alerts monitor invariants, queue age and lock contention rather than only CPU.

Back up PostgreSQL, private objects, configuration and key access; maintain independently durable erasure records. Define and measure recovery targets on selected hosting; demo does not inherit production HA merely from sharing code. Restore drill disables outbound side effects until reconciliation. Deploy staging early; rehearse reset/restore and connection loss on the actual public domain.

## Scale and acceptance

Dashboard views use cursor queries/read projections and explicit freshness; don't recount all credits on every page. Schedule bounded reconciliation batches with checkpoints. Avoid sensitive/high-cardinality metric labels. Test viewer direct-API denial, scoped downloads, reset vs in-flight issuance/payout, stale generation job, restore after erasure, queue retry and migration/rollback with pending events. Flag invariant failures visibly and preserve evidence for investigation rather than auto-editing balances.
