# F6 Credit issuance registry and buffer

Owner: `registry`; E7. Core issuance; replacement secondary. Inherits [common contracts](common-contracts.md). Rules: doc 06 section 7; clarifications DI3, DI5 and DI8.

## Domain and transaction

`IssueBasis`, `IssueApprovedDelta`, `ReserveCredits`, `ReleaseCredits`, `SellCredits`, `FreezeCredits`, `RetireCredits`, `ReplaceReversedCredit`. Registry owns economic states, freeze conditions, counters, buffer balances and issuance deltas. It obtains basis/calculation/rights through owner ports. Market owns orders/allocations and updates its aggregate in the same transaction through a port.

Issuance worker takes scoped type lock, cycle lock as consistently ordered with verification, validates active exact basis/generation, current rights, no withdrawal/freeze and complete evidence. Lock counter and carry-over, compute net/whole tonnes with decimal arithmetic, issue IDs and buffer accrual, update available aggregate, audit and outbox, then commit. Basis/delta business effect keys prevent concurrent duplicate issuance. Lock ordering for cycle vs type must be identical in all issuance/revocation/delta paths; verification revocation uses the cycle lock and never takes a later type lock to avoid a reverse-order wait.

One credit represents one tonne. Keep sub-tonne carry-over tagged by source calculation/vintage; the existing across-vintage policy must preserve provenance for the whole credit eventually formed. Never assign all accumulated mass to an unrelated latest calculation without constituent references. Exact provenance schema is required before multi-vintage carry-over ships; the demo can use one vintage.

## Interfaces and state

Issuance is worker/internal-port only, never a buyer-supplied amount endpoint. `GET /credits/:id?vintage=...` returns authorised state/provenance. Public owner ports receive expected state, credit reference, order owner and transaction, not arbitrary status strings. `POST /credits/retire` is buyer-authenticated and covered by F12.

AVAILABLE → RESERVED → SOLD → RETIRED; release returns an owned reservation to AVAILABLE. REVERSED and RETIRED are terminal; freeze is an eligibility flag. Replacement originates from whole buffer tonnes, excludes sale inventory and creates no new farmer earnings. Audit every adjustment; no delete-and-reissue shortcut.

## Security scaling and acceptance

DB transition guards, NOT NULL provenance refs and active-allocation uniqueness complement application rules. Composite vintage references work through all FKs if partitioning is enabled. Lock counters by plot/type/year; index state/type/vintage and expiry. Track issuance lag, buffer conservation, carry-over reconciliation and type lock waits. No chain call in issuance transaction.

Check worker crash/replay, stale/revoked basis, concurrent counter access, frozen plot, fractional carry-over, partition-aware double allocation and buffer exhaustion. A new methodology version never silently issues twice. Synthetic adapter issuance stays in demo namespace. Buffer sizing/release rules remain open production policy.
