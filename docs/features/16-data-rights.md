# F16 Consent withdrawal access correction and erasure

Owner: `identity` workflow; each module owns erasure of its PII. E2/S2.5. Demo uses synthetic data and basic access controls; full production key lifecycle is deferred. Inherits [common contracts](common-contracts.md).

## Request and authority

`RequestAccess`, `RequestCorrection`, `WithdrawConsent`, `RequestErasure`, `ClassifyRetention`, `ExecuteErasure`, `ConfirmRestoreReplay`. `POST /data-rights/requests {kind,purpose?,subjectRef}` requires subject verification or recorded authorised representation. An agent relationship is not blanket permission to erase a farmer's data. `GET .../:id` returns only requester/assigned reviewer status.

Workflow states RECEIVED → IDENTITY_CHECKED → CLASSIFIED → PROCESSING → COMPLETED/PARTIAL/NEEDS_REVIEW. Store purpose, policy version, retained classes and reason without raw sensitive copies. Retention/deadline rules require legal review; do not assert a blanket 72-hour breach deadline. Corrections append new authoritative facts rather than rewriting financial history.

## Erasure orchestration

Withdrawal stops new purpose-bound processing and invokes land withdrawal/freeze via a durable workflow; it is not confirmed offline. Owner workers recheck applicable consent before new processing, distinguishing existing financial obligations from optional new work. Identity emits subject/key-generation request events; owner modules acknowledge completion. Completion is based on acknowledgements/key state, not event enqueue success.

Per-class envelope keys permit selective destruction. Record erasure generation in a separately durable journal outside the backup chain before reporting completion; retry is generation-aware. Destroy eligible keys/mappings and clear cached copies/media derivatives according to policy. Retain encrypted legally required classes with recorded justification. Prevent recreating erased keys via stale workers, retries or profile reuse. Multi-person evidence needs per-person treatment.

## Restore and security

Restore in an isolated environment with traffic/worker side effects disabled. Replay erasure journal before key access/serving, verify completion, reconcile records/files and only then enable service. Blind indexes and old sync payload HMACs require a lifecycle that does not preserve forbidden linkability; stored status receipts can still handle known IDs without resurrecting erased content. See DI8.

Access exports minimise content, run asynchronously, encrypt private storage and expire download authority. Narrow privacy-reviewer permissions; audit access and approvals without putting PII into immutable hashes. Bound request rates without denying legitimate statutory requests.

## Acceptance

Test guessed-subject requests, unauthorised agent representation, partial retained classes, duplicate/generation-stale erasure, joint-holder data, backups restoring a destroyed key, cache/media cleanup and unsent notifications after withdrawal. No claim of production erasure compliance until the real policy and recovery drill are complete.
