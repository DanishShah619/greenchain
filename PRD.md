# GreenChain — PRD (summary)

> The full requirements now live in [docs/01-prd.md](docs/01-prd.md). This page is a pointer. Index of all documents, decisions and open questions: [MANIFEST.md](MANIFEST.md).

**What it is:** an INR-native climate-fintech platform where trusted institutions' field agents help smallholder farmers earn from verified soil-carbon credits, and corporates buy them with fair, auditable allocation and settlement.

**MVP flow:** assisted offline onboarding → proof capture and sync → versioned MRV → institution verification → credit issuance with buffer → corporate order with weighted FCAE → payment (Razorpay) → ledger and sandbox payout → certificates, chain proof, SMS to farmers.

**Design stance:** CP for credits, orders, payments and ledger; AP for field capture; modular monolith in one Indian region built to scale to ~500K farmers; en/hi/bn, icon-first, WCAG 2.2 AA, low-end Android.

| Document | Link |
|---|---|
| Tech stack & ADRs | [docs/02-tech-stack-adrs.md](docs/02-tech-stack-adrs.md) |
| User flows | [docs/03-user-flows.md](docs/03-user-flows.md) |
| Feature flows & failure modes | [docs/04-feature-flows-and-failure-modes.md](docs/04-feature-flows-and-failure-modes.md) |
| Backlog & story points | [docs/05-backlog-story-points.md](docs/05-backlog-story-points.md) |
| Technical design | [docs/06-technical-design.md](docs/06-technical-design.md) |
| Implementation plan | [docs/07-implementation-plan.md](docs/07-implementation-plan.md) |
| MRV module design | [docs/08-mrv-module-design.md](docs/08-mrv-module-design.md) |
| Pricing & invoicing design | [docs/09-pricing-invoicing-design.md](docs/09-pricing-invoicing-design.md) |
| System architecture | [docs/10-architecture.md](docs/10-architecture.md) |
| Reversal reserve & receivables | [docs/11-reversal-reserve-design.md](docs/11-reversal-reserve-design.md) |
| Payouts & KYC penny-drop | [docs/12-payouts-kyc-design.md](docs/12-payouts-kyc-design.md) |
