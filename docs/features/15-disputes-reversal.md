# F15 Disputes freezes appeals and reversal

Owner: `disputes` orchestrates case policy; registry/land/market/ledger own effects. E7. Secondary demo scope. Inherits [common contracts](common-contracts.md); DI1, DI4, DI5 and DI7 must be settled for implemented remedies.

## Case workflow

`OpenDispute`, `AttachEvidence`, `AssignInvestigator`, `ResolveNoFault`, `ConfirmFraud`, `Appeal`, `ExecuteRemedy`. A case transitions OPEN → INVESTIGATING → RESOLVED, with one allowed appeal to an independent mandated reviewer. Decisions are immutable and name evidence/fault/remedy version. Opening a case is not confirmation of fraud or permission to recover money.

`POST /disputes {plotId,creditRefs?,category,evidenceRefs,description}` requires a relationship/mandate and bounded valid evidence. Farmer may use assigned agent; buyer only disputes its relevant purchase; private complainant details are not exposed to every party. `POST /disputes/:id/decisions` requires current authority, expected version and reason; `POST .../appeals` preserves decision history.

Open workflow acquires type/order/credit/aggregate then payee locks where needed, freezes eligible inventory and pauses affected unpaid lots atomically through owner ports. Multiple open cases cannot unfreeze each other's holds: derived freeze/hold depends on all active reasons or a reference-counted case relation, never a single toggle. Existing paid/sold ownership stays snapshotted. Success vs freeze is decided by lock order/current state, not a committed PAID/FULFILLED gap.

## Remedy and financial policy

Before sale, confirmed reversal removes eligibility. After sale/retirement, choose explicit replacement or refund; whole-tonne buffer replacement creates no new farmer sale/payout. Ledger uses unique reversal-case keys and approved posting policy. No-fault reserve and confirmed-fraud future recovery are distinct; production recovery/holdback is legally gated. Insufficient buffer creates a visible refund/escalation path, not imaginary tonnes.

Generic reversal events must not trigger both remedies or duplicate earnings reversals. DI7 commission/refund accounting remains a blocker for the replacement path. Transactional case decision can enqueue a durable multi-step remedy saga; each step has state/idempotency/reconciliation, and case is not labelled financially complete until steps reconcile.

## Scale security and acceptance

Index open cases by region/institution/age and case-to-lot/credit links. Limit dispute creation/evidence volume to control abuse without disabling valid complaints. Expensive exports and investigation notifications run asynchronously. Monitor unresolved frozen inventory, held earnings and partial remedy age.

Test repeated open/decision/worker event, concurrent success/freeze, overlapping cases, appeal reversal, sold vs retired credit, missing buffer and dispute pause vs payout batch. No automatic score penalty or recovery based solely on an accusation; no negative payout or restored voided reservation.
