# 03 · User Flows

Status: Draft v1. Legend: 📶 online required · 📴 works offline · 📱 SMS (IVR is stretch, S13.2). Failure variants are expanded in [04-feature-flows-and-failure-modes.md](04-feature-flows-and-failure-modes.md).

## Personas

| Persona | Description | Constraints |
|---|---|---|
| **Farmer** (end customer) | Smallholder; often low literacy, shared/feature phone, owns or cultivates the plot | Does not operate the app (D2); interacts via agent and SMS (IVR later, S13.2) |
| **Field agent** | KVK/institution staff or trained local agent; operates the PWA | Intermittent network, low-end Android, sunlight, many farmers per day |
| **Verifier** | Institution reviewer (State Ag Dept, KVK, NGO) | Backlog and SLA pressure; desktop or tablet |
| **Corporate buyer** | ESG/sustainability team | Needs auditability, certificates, BRSR-aligned reports |
| **Admin/auditor** | Platform operations | Needs invariants, audit chain, dispute tools |

## Flow F-A · Agent onboards a farmer (village, no signal) 📴
1. Agent opens app (already logged in; session cached) → "New farmer" (icon + voice prompt in chosen language).
2. Captures farmer phone number, name as on bank/land record, language preference.
3. **Consent:** reads/plays the consent text in the farmer's language; farmer gives consent by signature/thumbprint photo or recorded voice; stored with version and agent ID. Farmer OTP confirmation is *deferred* until connectivity (📶, step 9).
4. Captures land-record reference (photo + typed ID), rights type (owner / cultivator-with-owner-consent), joint owners and nominated payee.
5. Draws plot polygon on cached map or walks the boundary with GPS; captures geo-tagged photos (compressed on device).
6. Records crop cycle (crop, season, dates).
7. Everything lands in the outbox with `client_event_id`s; screen shows "Saved on this phone · 0 of 7 synced".
8. When network returns the app syncs metadata first, media after; results shown per item (✔ synced / ⚠ needs fix).
9. 📶 Server sends OTP to the farmer's phone; the agent enters it with the farmer present, or the farmer confirms by SMS reply; **payout setup is blocked until this and the bank/UPI penny-drop name match pass**. Institution staff also make random verification callbacks to check consent.
10. 📱 Farmer receives SMS in their language: registration received, what happens next.

**Exit states:** `ONBOARDED_PENDING_VERIFICATION`, `KYC_BLOCKED` (name mismatch), `RIGHTS_DISPUTED`, `DUPLICATE_PLOT`.

## Flow F-B · Proof capture & verification
1. 📴 Agent (or farmer's follow-up visit) captures geo-tagged proof photos and practice confirmation per crop cycle; device GPS and EXIF validated on device; agent GPS must be near the plot (geofence).
2. 📶 Sync; server stores media with hash, computes skew, flags anomalies.
3. Worker fetches cached NDVI series, runs the versioned methodology → calculation (gross CO₂e, confidence).
4. Verifier queue sorted by risk (low confidence, flagged skew, high-value, random spot-check sample).
5. Verifier reviews proofs + NDVI; decides `VERIFIED`, `NEEDS_VISIT`, or `DISPUTED`.
6. On `VERIFIED`: credits issued net of buffer; FRPS updated; 📱 farmer SMS "X credits issued, awaiting buyer".

## Flow F-C · Corporate purchase
Detailed screen design, buyer-visible states, recovery paths and demo scope: [Company buyer journey](14-company-buyer-flow.md).

1. Register with GSTIN/CIN; institution admin approves.
2. Sets annual CO₂e target (BRSR-aligned view).
3. Browses available inventory (type, vintage, state), sees posted price band and live availability (“last updated” stamp).
4. Enters quantity → 📶 `POST /orders`: FCAE allocates and reserves; the buyer sees allocation summary (count of farmers/plots, vintage mix) and any **shortfall** with accept-partial / cancel.
5. Pays via Razorpay (UPI/netbanking/card). Reservation extends while the payment attempt is in flight (hard max).
6. Webhook confirms → order `PAID`, then `FULFILLED` in the same transaction (credits SOLD, ledger rows written); certificate PDF with credit IDs generated; chain proof attached when minted. If the webhook arrives after the reservation lapsed, the platform re-checks the same credits and either completes the order or refunds in full.
7. Buyer retires credits (full or partial) for a reporting period; retirement certificate issued.

## Flow F-D · Farmer gets paid
1. Credit sold → ledger entry (gross, commission %, net) per farmer.
2. Payout job pays the nominated payee (sandbox in MVP) with retry/backoff; failures flagged for review.
3. 📱 SMS to the farmer: amount, which credits, date, reference. The farmer can ask the agent for a statement (balance, last 5 payments); a spoken IVR statement is a stretch item (S13.2).

## Flow F-E · Verifier / institution
Onboard with mandate (region/institution type) → work queue → review → decision → report export → quality metrics (approved/disputed ratios, SLA, reversal rate of their approvals).

## Flow F-F · Dispute, freeze, reversal
Anyone (verifier, admin, buyer, farmer via agent) can raise a dispute with evidence → plot/credits `FROZEN` → institution investigation → resolve (unfreeze) or `REVERSED` (buffer retired for buyers, notices sent). Everything audit-logged.

## Flow F-G · Data rights (DPDP)
Farmer requests access/correction/deletion via the agent or a helpline → ticket → identity check → fulfil within the policy window; PII is made unreadable by destroying the subject's key and pseudonym mapping, while financial and audit records are retained (encrypted, access-restricted) with the legal basis documented.

## Degraded-network matrix

| Situation | Agent app | Corporate/Verifier web |
|---|---|---|
| No network | Full capture, queue, local drafts; transactional actions disabled with reason | n/a (online product) |
| 2G / flaky | Small batches, resumable uploads, backoff; progress per item | Pages degrade (no heavy dashboards), retry banners |
| Server 503 | Keeps queueing; “Server busy – will retry” | Read-only banner; no order placement |
| Payment gateway down | n/a | Order held to reservation limit then released; clear message; retry later |
| SMS undelivered | Agent work queue shows “farmer not notified – tell them in person” | n/a |
