# F5 Institution verification

Owner: `verification`; E6. Core demo feature. Uses MRV, capture and land read/command ports. Inherits [common contracts](common-contracts.md).

## Workflow and immutable decisions

Queue is a projection of cases needing review, ordered by risk, deadline and stable ID. `ClaimCase` leases reviewer ownership; it is not an approval. `ReviewEvidence`, `WaiveEvidenceSlot`, `RequestVisit`, `VerifyCalculation`, `DisputeCase`, `RevokeBasis` are separate use cases. Waiver triggers MRV recompute before a decision can be made. Record reviewer mandate and evidence snapshot.

`GET /verification/cases?cursor=...` returns assigned/mandated cases. `POST /verification/cases/:id/claim {expectedVersion}` claims atomically. `POST /verifications {cycleId,calcId,decision,evidenceSnapshot,expectedCaseVersion,reason}` must match the latest calculation under the same cycle lock used by MRV. If inputs changed, return STALE_CALCULATION and show what requires rereview. A second concurrent decision cannot select another active basis.

VERIFIED writes immutable decision and active issuance basis, audit and issuance intent in one transaction. NEEDS_VISIT writes decision/task without issuance. DISPUTED routes an evidence-backed dispute through its owner. Follow [DI3](design-issues.md) for revocation/reverification; withdrawal only replaces an active basis before issuance. After issuance use delta/reversal.

## Authorisation and fraud controls

Mandate must cover the plot/case, not just a claimed verifier role. An agent cannot approve their own capture. Where team staffing prevents separation, use seeded separate demo identities and disclose simulation. Production exceptions require a reasoned policy, not hidden permission bypass. Parameter/pricing publication has independent reviewer rules outside this workflow.

Private proof downloads are short-lived and scope-checked. Claim leases expire; supervisor reassignment preserves history. Validate notes and escape rendering. Random sampling uses a recorded seed/policy version so selection can be audited. A fraud flag is evidence for review, not automatic financial punishment.

## Scale and checks

Index queue by institution/region/state/risk/deadline and paginate. Precompute risk/SLA views; don't recompute satellite inputs on every screen. Bound concurrent claims and measure backlog/age by institution, review latency and reversal rate. A reviewer crash releases only the lease; committed decisions remain durable.

Acceptance: out-of-mandate read/write/download fails; changed calculation invalidates a stale approval; concurrent approvals select one active basis; basis revoked before issuance is rejected by registry; a missing slot cannot be waived inside an approval to bypass MRV; claim expiry does not delete work. Record SLA as configured assumption, not a guaranteed seven-day service.
