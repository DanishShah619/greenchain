# F14 Notifications farmer visibility and agent follow-up

Owner: `notify`; E13. Core demo: synthetic inbox and agent tasks. SMS integration later; IVR stretch. Inherits [common contracts](common-contracts.md).

## Event-to-template flow

`PlanNotification`, `DeliverNotification`, `RecordDeliveryReceipt`, `CreateFollowUp`, `AcknowledgeTask`. Consume issuance, sale, payout and review events after commit. Snapshot language/template version and limited display amounts; source business state remains authoritative. Use unique `(sourceEvent,recipient,channel,templateVersion)` to prevent duplicate notification planning.

Notify resolves contacts only through identity's narrow authorised port. Never export full farmer profiles into queue payloads. Templates are reviewed en/hi/bn variants; fallback follows stored preference and agent task, not an unexplained language switch. Distinguish queued/provider-accepted/delivered/failed/read states; an SMS receipt does not prove farmer comprehension.

`GET /notifications?cursor` returns user's inbox; `GET /agent/tasks` restricts assignment; `POST /agent/tasks/:id/ack {expectedVersion,outcome}` records follow-up. Provider delivery callback verifies adapter authentication and matches known notification/attempt. Demo delivery simulator is presenter-only and never sends to arbitrary numbers.

## Security and failure

Minimal SMS content; sensitive evidence/account details require authenticated statement access. Limit outbound attempts and per-recipient costs. Provider UNKNOWN_OUTCOME queries a supported receipt key where available; if the provider cannot deduplicate, record possible duplicates and bound retry rather than promising exactly-once SMS. Undelivered farmer notice creates one agent task; the sale/payout is never rolled back because notification failed.

A revoked consent/contact change cancels unsent communication according to purpose policy; legally required service records need approved treatment. Signed links are short-lived/single purpose and still follow resource policy. Logs retain redacted provider IDs and outcomes, not raw contact numbers/messages.

## Scalability and acceptance

Separate delivery queue budget from financial work, batch by template/provider limits and backoff with jitter. Index due attempts and assigned open tasks. Observe delivery/failure rate, age/cost, language fallback and overdue tasks using bounded labels. Public users cannot browse all notification receipts.

Test repeated event, reordered receipts, provider outage, wrong language, revoked contact and duplicate follow-up creation. Agent can recover an undelivered notice visibly. Inbox states match committed issuance/sale/payment facts. IVR/real SMS are optional adapters with their own vendor/DLT requirements, not dependencies of demo login or completion.
