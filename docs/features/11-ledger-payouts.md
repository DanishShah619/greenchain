# F11 Earnings journal invoices and payouts

Owners: `ledger`, `payouts`, `invoicing`; E10 and reserve stories E7. Core demo: correct earnings/accounting, simulated rail, statement and receipt. Detailed posting/rail rules remain [doc 11](../11-reversal-reserve-design.md) and [doc 12](../12-payouts-kyc-design.md). Inherits [common contracts](common-contracts.md).

## Accounting boundary

Ledger owns append-only earnings, balanced journal entries, earning lots, receivables and reserve. `RecordFulfilment(tx,snapshot)` receives immutable per-credit gross/commission/tax/payee data; it does not reprice or synchronously read back through market. Effect key EARN:orderItem prevents duplication. Follow DI1: earnings, lots, journal/funding and outbox commit with fulfilment under ordered payee/reserve locks. Payout/invoice consumers do not post the earning again.

Every journal entry balances debit/credit before commit; account currency and paise units are explicit. Corrections reference original entries. Ledger views derive HELD/RELEASABLE/ON_HOLD/CANCELLED/consumed state; no update/delete of posted money. Statement reads preserve sale gross, commission, farmer net, recovery, paid and outstanding as distinct values. Reconcile both journal and earnings interpretations, including reversal remedies; DI7 blocks ambiguous replacement accounting.

## Payout contract

Daily IST batch calls `LedgerPayoutPort.openBatch(tx,payee,asOf)` after taking payee lock. Select releasable lots, current approved account/cool-off snapshot, calculate DI6 pre-recovery farmer-net batch base, minimum/limits, gated recovery and payout. Insert batch items uniquely; each lot has one active payout. Holdback/recovery remains production-gated per doc 11. Subthreshold lots roll over without recovery posting.

Send job writes a durable attempt, calls rail outside transaction using payout ID as key, then appends classified result. INDETERMINATE queries by key before resend. SENT is not SETTLED. Returned/cancelled payout releases items and compensates recovery in the same transaction. A payee change invalidates unsent account-version snapshots for recheck; sent outcomes remain tied to the account actually used. Never switch destination silently mid-flight.

## Invoices APIs and permissions

`GET /farmers/:id/earnings?cursor` and `/payouts` are subject/assignment scoped. `GET /orders/:id/receipts` is buyer scoped. Invoice worker copies immutable order/ledger tax snapshots, claims fixed-order number series and generates document once. Credit notes require explicit remedy policy. Private files use authorisation-rechecked downloads. Finance retry/manual adjustment endpoints require reason, unique key and second reviewer where configured; they never edit journal totals.

## Scale and checks

Indexes on payee/releasable time, active payout item, due attempts and invoice business key. Batch payees in bounded pages; cap send/reconciliation queues independently. Track payable conservation, journal imbalance, reserve exhaustion, stuck rail outcomes and invoice lag. Race-test batch rerun, account changes, dispute pause and return vs settlement. Verify rounding, recovery <= configured cap, no negative payout, one receipt number and zero reconciliation difference. Retain failures visibly for finance rather than retrying indefinitely.
