# F10 Payment collection callbacks and refunds

Owner: `payments`; E10. Core demo simulator; optional Razorpay sandbox later. Inherits [common contracts](common-contracts.md). Provider-specific event fields/signature semantics must be checked against provider documentation during adapter implementation.

## Ports and durable intent

`PaymentGateway.createAttempt`, `getAttempt`, `refund`, `getRefund` isolate the provider. Pure policies classify outcomes; application commands are `CreateAttempt`, `RecordProviderEvent`, `ResolvePending`, `HandleSuccess`, `RequestRefund`, `ResolveRefund`. Payments owns provider intents/attempts/events/refunds. Market owns reservations/order state; ledger owns earnings/journal. Orchestration follows DI1, passing immutable values instead of mutually importing modules.

`POST /orders/:id/payment-attempts {acceptSnapshotId}` checks buyer ownership, price acceptance and reservation state. Persist attempt identity and intended amount before network work. Provider amount/currency comes from stored snapshot, never the client. After external intent creation, store provider reference and reconcile uncertain results before creating another intent. A gateway lacking idempotent creation requires a specific reconciliation policy; do not assume a client key grants provider idempotency.

`POST /webhooks/:provider` uses bounded raw-body capture and provider signature verification before parsing/applying. Match a trusted provider order/reference and exact amount/currency. Store event identity and state changes atomically; repeated delivery is a no-op. Keep encrypted/redacted evidence for required retention; logs contain no raw financial payload. Browser redirect is informational, never proof of payment.

## Success and late success

Lock type/order/credits and validate ownership. On success commit attempt, order fulfilment, SOLD credits, immutable accounting and downstream jobs together. Expired/cancelled or displaced reservation takes REVALIDATING: reacquire the same credits all-or-nothing if eligible/free, otherwise queue full refund. A second successful attempt on a fulfilled order creates a DUPLICATE refund record without changing its fulfilled state. Refund processing persists amount/reason/business key and queries uncertain outcome before resending.

Out-of-order non-success events cannot undo a successful attempt. Provider reconciliation polls pending/uncertain records with bounded concurrency/backoff and per-provider budgets; network calls happen outside locks followed by version/state checks. Events about unrecognised provider references are quarantined and alerted, never assigned from untrusted buyer IDs.

## Security scale and acceptance

Separate sandbox/live secrets; demo controls use presenter-only endpoints bound to demo adapter. External callbacks are rate/body bounded; signature failures never enqueue business work. Reserve worker concurrency for reconciliation and refunds. Track pending age, amount mismatches, duplicate successes, refund age and reconcile differences.

Test forged callback, repeated/scrambled/delayed success, provider timeout after acceptance, duplicate successful attempt, cancellation vs webhook and worker crash after refund send. Every path ends fulfilled, pending with visible recovery, or refunded; none duplicates earnings or refunds. No live provider account is required for the deterministic simulator.
