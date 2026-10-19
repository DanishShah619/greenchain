# F7 Farmer reliability scores and tiers

Owner: `frps`; E8. Core demo uses a small verified-event set. Inherits [common contracts](common-contracts.md).

## Pure policy and event workflow

`ApplyReliabilityEvent`, `RecomputeScore`, `PublishRuleSet`, `GetTierHistory`. Rules map evidence-backed domain events to deltas, monthly caps, score bounds and tier/commission bands. FRPS cannot authorise payment or change land rights. It owns immutable score events and replayable score/tier projections. Rule versions are pinned per event; historical replay does not reinterpret old events using today's rules.

Consume verified proof/practice/verification/dispute outcomes from outbox. Effect uniqueness is `(sourceEvent,ruleVersion,subject)`; caps apply atomically under score/account lock. Confirmed fault attribution is required for punitive financial consequences; opening a dispute alone should not be treated as confirmed fraud. Any provisional reputation treatment is explicit and reversible through compensating events.

Emit `FrpsTierChanged {groupId,tier,commissionBps,seq,ruleVersion}` when appropriate. Group identity is resolved through authorised snapshots/ports. Market maintains its own sequence-aware projection; fulfilment copies allocation-time commission snapshots. FRPS does not call market synchronously or rewrite historic earnings. Projection bootstrap/replay includes checkpoint and events after checkpoint so startup does not miss a concurrent change.

## API and security

`GET /farmers/:id/reliability` returns scoped score, tier and explanations. `GET .../history` is cursor-paged. Rule publication requires creator/reviewer separation, validated bounds and effective time. Admin adjustments are reasoned events with evidence, never raw score PATCH. Buyer-facing allocation sees tier/weights without private incident details.

## Scale and failure

Index subject/event time and effect key. Incremental updates serve reads; bounded nightly reconciliation recomputes without loading all history into memory. Rebuild into a shadow projection and compare before swapping. Reject stale sequence events; park gaps for replay. Monitor drift, duplicate events, cap saturation and lag. No Redis locks or shared mutable fairness weights.

## Acceptance

Shuffled duplicate event delivery yields the same score after ordered replay; monthly cap holds under concurrency; all score/tier transitions remain explainable; changed tier does not change a placed order's commission; erased subject cannot be recreated from events; stale market projection event cannot regress tier. Starting score and cap amounts remain configurable research assumptions, not validated behavioural predictors.
