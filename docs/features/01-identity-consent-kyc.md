# F1 Identity consent and payee verification

Owner: `identity`. Stories E1 auth and E2. Inherits [common contracts](common-contracts.md). Demo: seeded presenter identities and simulated KYC; no real bank details. Existing policy: [doc 12](../12-payouts-kyc-design.md).

## Use cases and boundaries

`RequestOtp`, `VerifyOtp`, `RegisterDevice`, `RevokeDevice`, `RecordConsent`, `OnboardFarmer`, `VerifyBuyer`, `InitiatePayeeVerification`, `ReviewNameMatch`. Identity owns sessions, devices, subjects, consent versions, keys and KYC attempts. Land owns nominated plot payees; identity verifies an account but cannot silently change plot rights. Application ports are `SmsPort`, `KycPort`, `KeyStore`, `Clock` and owned repositories.

Offline onboarding captures proposed identity/consent facts; server confirmation and KYC are later steps. Track phone verification, purpose consent and payee verification separately rather than a misleading single VERIFIED flag. A shared phone prompts review, not automatic rejection. A name-match score is versioned and low scores route to review rather than rejection.

## API and data contract

- `POST /auth/otp/request {phone}` → generic challenge response; `POST /auth/otp/verify {challengeId,code}` → rotated session cookie. Challenge expiry, hash and atomic attempts are server-owned. Consume once.
- `POST /devices {publicKey,deviceLabel}` after fresh login; revoke requires privilege/reason. Delete associated sessions atomically; keys are retained as needed to classify queued events.
- Farmer creation is submitted through sync as `{clientSubjectId,language,consentVersion,purpose,evidenceSlotIds}`; server allocates permanent identity and maps stable client references.
- `POST /payees/:id/verifications` queues KYC; `GET .../:verificationId` returns status; manual review requires scoped verifier permission. Clients cannot submit their own VERIFIED result.

KYC external calls happen after durable intent. Stable verification ID prevents repeated penny-drops. Result callbacks/polls deduplicate and append history; account version prevents an old result validating a changed account. Require fresh verification and configured cool-off on change. Financial account references remain encrypted/tokenised.

## Security and scaling

Agent can onboard only assigned subjects; buyer approval and staff role assignment are not self-service fields. Evidence-backed consent stores purpose/language/text version and collector. Anti-enumeration, OTP throttling, CSRF, session/device revocation and reasoned review are mandatory. No Aadhaar storage. Test scripts/HTML in display names and redact auth/KYC output.

Index live sessions by hashed token, device and expiry; index challenges by scoped phone identifier and expiry. Batch cleanup with limits. Measure OTP contention/abuse and KYC queue lag; provider latency must not hold DB locks. Circuit-breaker/provider outages leave explicit PENDING/NEEDS_REVIEW states, not false success.

## Acceptance

Concurrent valid OTP uses create at most one consumed challenge result; revoked sessions fail on the next request; another institution cannot inspect consent evidence; repeated KYC request causes one verification effect; old account result cannot unlock a new account; offline onboarding works while payout remains blocked. Demo identity shortcuts fail in production configuration.
