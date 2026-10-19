# F9 Orders fair allocation and reservations

Owner: `market`; E9. Core demo. Exact algorithm remains doc 06 section 6; this file specifies application boundaries. Inherits [common contracts](common-contracts.md).

## Pure allocation and ports

`AllocateOrder(inputs)` is pure BigInt/rational weighted water-filling with largest-remainder rounding and stable tie-breaks. Inputs include quantity, eligible group supply, tier/sequence, waiting days, quota room, cap and one server `asOf`. Return allocations and SUPPLY/CAP/QUOTA shortfall; never silently relax limits. Persist inputs/output/policy version for replay.

`PlaceOrder`, `AcceptShortfall`, `CancelOrder`, `ReapReservations`, `ValidatePaymentOwnership`, `FulfilOrder` orchestrate registry/pricing/ledger via explicit ports or a composition-root workflow. No HTTP handler computes money or picks credits.

`POST /orders {creditType,quantity,filters,quotedTotalPaise?}` requires approved buyer and idempotency key. Response includes scoped order ID, accepted quantity, shortfall reason, allocation explanation, price snapshot and reservation deadline. If partial fill requires acceptance, payment creation rejects until accepted; acceptance selects the existing snapshot or cancels/recreates when expired. One order has one credit type. `POST /orders/:id/cancel` affects only its still-owned active reservation.

## Consistency and expiry

Lock buyer limits, scoped type, order, credits and group aggregates in documented order. Reap lapsed reservations, read priced eligible aggregates, allocate, select credits, snapshot prices/commission and reserve in one transaction. Registry state changes and market count updates use the same transaction. Membership in an institution is not permission to operate another buyer's order.

Gateway-confirmed PENDING can extend hold to configured limits; row creation alone cannot. Expiry is a server deadline. A worker queries provider outside locks, then rechecks order/attempt version before applying the answer. Fulfilment uses DI1 and DI4; payment success must verify current credit ownership even if the visible order is AWAITING_PAYMENT. Failed/expired reservations cannot reset farmer waiting time. Revalidation never steals sold/reserved credits.

## Scaling security and checks

Per-type lock deliberately serialises allocation. Measure wait separately from algorithm/SQL time; add bounded deadlines and stable retryable overload responses. Keep network calls outside the transaction. Aggregate indexes match buyer filters; verify query plans for 10k/100k skewed groups. Rate limits plus buyer/group quotas prevent reservation hoarding. Admin cap override requires audited reason and does not override quota.

Test concurrent last-credit orders, cancellation/expiry/freeze vs payment, repeated place key, changed payload KEY_REUSE, small Q cap discontinuities, deterministic shuffled inputs, aggregate recount and changed payee rekey. Buyer UI explains shortfall and expiry. Pilot seeds must satisfy actual caps/quotas; scope overrides cannot be hidden in fixtures.
