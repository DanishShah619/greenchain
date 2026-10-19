# GreenChain feature specifications

Status: Draft implementation specifications, 2026-10-11. These expand the existing requirements; they do not imply implementation, scientific approval, legal approval, or a larger demo scope. New API paths and limits are proposed contracts. Existing business decisions remain authoritative except where an explicit clarification is recorded in [design issues](design-issues.md).

Read [common contracts](common-contracts.md) first. Each feature inherits its authorisation, transaction, idempotency, pagination, accessibility, instrumentation and demo-isolation requirements. [Public demo scope](../13-public-demo-plan.md) determines release inclusion; the full production backlog is not required before the demo.

The [system design baseline](../15-system-design.md) specifies the complete lock protocol, cross-module commits, worker leases, capacity model and recovery gates. It supersedes conflicting engineering paragraphs in older drafts.

| ID | Feature design | Primary owners | Demo priority |
|---|---|---|---|
| F1 | [Identity and consent](01-identity-consent-kyc.md) | identity | Core; KYC simulated |
| F2 | [Land and rights](02-land-rights.md) | land | Core |
| F3 | [Offline capture and media](03-capture-sync-media.md) | capture | Core |
| F4 | [Carbon calculation](04-mrv.md) | mrv | Demo-only adapter |
| F5 | [Verification](05-verification.md) | verification | Core |
| F6 | [Credit registry and buffer](06-registry-buffer.md) | registry | Core |
| F7 | [Reputation](07-frps.md) | frps | Core score/tier |
| F8 | [Inventory and pricing](08-market-pricing.md) | market, pricing | Core |
| F9 | [Orders and allocation](09-orders-fcae.md) | market | Core |
| F10 | [Payments and refunds](10-payments-refunds.md) | payments | Core simulator |
| F11 | [Accounting and payouts](11-ledger-payouts.md) | ledger, payouts, invoicing | Core; rail simulated |
| F12 | [Certificates and retirement](12-certificates-retirement.md) | certificates, registry | Certificate core; retirement secondary |
| F13 | [Chain proof and audit](13-chain-audit.md) | chain, audit | Audit core; chain optional |
| F14 | [Notifications](14-notifications.md) | notify | In-app demo inbox |
| F15 | [Disputes and reversal](15-disputes-reversal.md) | disputes, registry, ledger | Secondary |
| F16 | [Data rights](16-data-rights.md) | identity, PII owners | Synthetic demo; production workflow later |
| F17 | [Administration and operations](17-admin-operations.md) | admin, module owners | Core recovery/reset |
| E14 | [Research evaluation](18-research-evaluation.md) | separate offline evaluator | Optional comparison view |

## Implementation order

Foundation: composition root, session/context enforcement, migrations, object storage and transactional jobs → identity + land + capture → MRV + verification + registry → FRPS + pricing + market → payments + ledger + payouts → certificates + notifications. Add secondary paths after this hosted vertical slice works. Audit and observability ship with each mutation, not at the end.

For each feature, implement its domain rules, application use cases, persistence adapter, HTTP/worker adapter, then acceptance checks. No UI should invent a state transition absent from its application contract. Present externally pending work as pending; no optimistic success for issuance, payment or payout.

## Design review gate

A feature is ready to implement when its owned data, actor/object authorisation, immutable snapshots, transaction boundary, replay identity, failure states, external calls and meaningful checks are clear. The issues register identifies remaining blockers. Estimates must be revisited with the team; these specifications do not change the existing point total automatically.
