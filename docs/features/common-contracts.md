# Common architecture and security contracts

Status: Proposed implementation baseline. Applies to every feature in this directory. Business formulas and production policies remain in docs 06, 08, 09, 11 and 12.

## Clean architecture

```text
src/modules/<owner>/
  domain/       entities, value objects, pure policies, transitions
  application/  commands, queries, port interfaces, orchestration
  infra/        SQL repositories, vendor adapters, queue handlers
  http/         validation, authentication mapping, DTOs
  index.ts      deliberately small public interface
src/bootstrap/  composition root, API entrypoint, worker entrypoint
src/kernel/     transaction interface, clock, ids, money, event envelope
```

Domain code imports no HTTP framework, ORM, vendor SDK or environment variables. Application code depends on port interfaces; infrastructure supplies implementations. HTTP handlers validate and delegate; they do not allocate credits or post money. Repository types do not escape through public ports. No global service locator or shared writable repository.

Cross-module access uses an owner's command/read port. Share an explicit transaction handle where atomicity is required; ports must not secretly start/commit nested transactions. A composition-root workflow can call several ports using immutable values without adding reciprocal imports. Events notify independent consumers after commit. Worker DB grants are restricted to owned tables and approved read views; a shared API DB role is not proof of module isolation. Enforce import rules in CI.

## Authorisation and scope

Resolve `ActorContext {actorId, role, institutionId?, mandateIds, scenarioId?, correlationId}` from verified server state, never request role fields. Permission is actor + action + object + scope + current state. Lists, detail reads, exports, downloads and commands apply the same policy. A guessed ID or valid signed link does not grant broader access.

Institution isolation applies to private evidence and staff operations. The approved marketplace is a deliberately cross-institution view of eligible inventory, with restricted provenance disclosure. A buyer sees its own orders/financial records; a verifier sees its mandate; an agent sees assigned cases; finance permissions are distinct from ordinary admin permissions. Route roles can be permission grants on the existing role model rather than new public registration roles.

Demo scenario scope is separate from institution scope. Scenario IDs participate in demo object references, uniqueness, idempotency and job routing. Every referencing row/job/file must resolve to the same authorised scenario; verify with composite keys or owner-port checks. Public visitors see a read-only showcase. Presenter reset requires explicit privilege. Production does not accept a client-supplied demo flag, clock or methodology adapter.

Secure cookie sessions use TLS, HttpOnly, explicit SameSite policy and session rotation. Cookie-authenticated mutations require CSRF protection and trusted-origin checks; CORS is a separate boundary, not authentication. Avoid session tokens in localStorage or URLs. OTP responses do not enumerate accounts; rate-limit by phone/device/IP with atomic server counters and bounded attempts. Session expiry leaves offline events queued. Webhooks use separate signature authentication and no browser session.

Baseline references: [OWASP authorisation](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) recommends default denial and permission checks on every request; [OWASP file uploads](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) covers content checks, bounded uploads and private storage. Apply these controls at the application/resource boundary as well as HTTP.

## HTTP and replay contract

All proposed paths are under `/api/v1`. Validate allowed fields, lengths, enums, identifier format and decimal/money representation. Reject unknown mutation fields. Money is integer paise encoded as decimal strings; methodology decimals are fixed-scale strings. UTC timestamps use ISO 8601; IST batch/fiscal dates are explicit fields. Client timestamps never set server deadlines.

Mutation requests use `Idempotency-Key`, except sync events and provider callbacks which have their own stable identities. Store `(scope, actor, operation, key)`, canonical payload fingerprint, resource/result and processing state. Same key/same payload returns the stored result; changed payload yields `KEY_REUSE`. Business uniqueness remains in SQL even if endpoint receipt retention expires. Concurrent same-key requests never run the effect twice. Return stable retry instructions for in-progress work; do not hold a transaction during external I/O.

Responses distinguish committed work (`200/201`) from queued work (`202` with job/resource URL). Errors have `{code, correlationId, retryable, fieldErrors?}`; no SQL, secret, bank details or cross-scope existence leak. Use `401`, `403` or intentionally consistent `404`, `409` for state/version conflicts, `422` for invalid business inputs and `429` with retry delay. Lists use capped cursor pagination with a unique tie-breaker. Filters/sorts are allowlisted; SQL is parameterised. Missing configuration fails explicitly, never through a guessed default.

## Transactions, external work and locks

Business state, audit insertion and durable job enqueue commit together. Outbound network work follows a durable intent → external call → result/reconciliation pattern outside locks. At-least-once workers use business effect keys and unique constraints; successful queue delivery alone does not prove business completion.

Use ordered locks and bounded whole-transaction retries for deadlocks/serialization failures. Retry with the same operation identity. Type locks remain a measured allocation bottleneck; replicas do not relieve authoritative writes. The ledger/fulfilment boundary is clarified in [design issues](design-issues.md). Scope advisory keys by demo scenario when demo data share a database; production credit-type order remains consistent. [PostgreSQL 16 locking guidance](https://www.postgresql.org/docs/16/explicit-locking.html) describes transaction lock lifetimes and consistent acquisition ordering.

Event envelope: `{eventId, eventType, schemaVersion, aggregateId, aggregateVersion, scenarioId?, occurredAt, correlationId, payload}`. Payloads contain identifiers/minimal facts rather than raw PII. Consumers deduplicate `(consumer,eventId)` in the same transaction as their effect. Sequence-sensitive projections ignore stale events; gaps trigger replay/bootstrap, not blind application. Worker claims have bounded leases/attempts and dead-letter visibility. Reserve worker capacity for payments/payouts and limit MRV/media concurrency.

## Security, durability and scale

Private buckets, generated object keys, scoped short-lived URLs, no arbitrary URL imports, upload quotas, content validation and safe download headers. Logs redact OTPs, sessions, account tokens and sensitive payloads. Metrics avoid per-person/plot labels. Secret rotation has an overlap strategy; privileged actions record reason and actor. Exports are bounded asynchronous jobs with expiry and authorisation rechecked at download.

Targets from doc 06 remain hypotheses: allocation p95 <200 ms DB time and sync batch p95 <2 s. Each feature records latency, query plans, lock wait, error rate and backlog; test realistic skew/bursts, not just row counts. Proposed starting batch/page/media limits must be measured before being treated as production guarantees. Add pooling, indexes, replicas and partitioning based on observed pressure; financial writes never use a lagging replica as authority.

Database PITR alone does not back up evidence or keys. Restore plans include object storage, key access, configuration, erasure-journal replay and reconciliation before traffic resumes. Unsynced browser storage has weaker durability; show local vs server status and quota failures honestly.

All screens inherit en/hi/bn support, externalised strings, keyboard/screen-reader operation, accessible errors, large touch targets and low-memory behaviour. Audio/translation completeness is a release checklist, not evidence of scientific validity. Acceptance checks must verify business outcomes, cross-scope denial, crash/replay and failure recovery.
