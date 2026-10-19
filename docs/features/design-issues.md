# Design clarifications and implementation blockers

Status: Draft corrections discovered during feature specification. The proposed choices below guide new feature drafts; referenced older paragraphs must be reconciled before their affected implementation ships. These are engineering decisions, not changes to scientific or legal policy.

2026-10-12 update: [system design](../15-system-design.md) adopts the engineering baseline for DI1–DI5 and partition-safe references in DI8. Core conflicting paragraphs in docs 06/08/10/11 have been reconciled. No migrations or runtime implementation exist yet. DI6's live payout-minimum policy, DI7's replacement commission treatment, cross-vintage carry-over and production retention decisions remain open. Historical change-log entries describe past drafts, not current implementation instructions.

## DI1 Fulfilment and accounting transaction

Doc 06 says FULFILLED inserts earnings without payee/reserve locks; doc 11 adds same-transaction journal/reserve posting requiring those locks. Implementing both literally is unsafe.

Proposed contract: the payment application workflow owns one transaction. It takes type/order/credit/aggregate locks, then sorted `payee_ledger_state` locks and the reserve lock when needed. `market` returns an immutable fulfilment snapshot by value; `ledger` posts earnings, lots, balanced journal entries and reserve funding inside that transaction. Neither module reads back through the other to orchestrate fulfilment. Ledger-only and payout workflows start at payee locks and never acquire earlier market locks. Outbox consumers must not post EARNED again; the synchronous posting has a unique business key.

This preserves atomic SOLD/earnings/journal semantics but increases contention on a global reserve. Measure reserve lock wait; aggregation of reserve funding is a later reviewed optimisation, not a silent weakening of accounting.

## DI2 Audit sequence gaps

Doc 06 assumes a database sequence gap proves an unchained row was deleted. Sequence values can be consumed by rolled-back transactions: [PostgreSQL sequence documentation](https://www.postgresql.org/docs/16/functions-sequence.html). Missing values alone are not proof of tampering.

Demo baseline: verify MACs on present rows and hashes/contiguity of committed `chain_seq`, with fenced chainer ownership. Treat `insert_seq` as insertion-order metadata; do not page on its gaps or claim detection of every pre-chain deletion. Production detection of deleted unchained/tail records needs independently durable committed receipts or a reviewed external WAL/CDC witness. A hash chain inside the same compromised database is not an independent witness. Record this limitation in audit UI/runbook.

## DI3 Revoked issuance basis

Docs 06/08 combine a UNIQUE cycle basis with revocation and a new verification decision. A second INSERT under a global UNIQUE(cycle_id) would fail.

Proposed schema: immutable `issuance_basis` rows with `basis_id`, cycle and reviewed calculation; immutable revocations; a verification-owned `cycle_verification_state` row carries `active_basis_id` and generation. Under the cycle lock, only one unrevoked basis is active, and a replacement is permitted only before any issuance. Registry records the exact basis ID and rechecks generation/revocation under the shared lock. Once issued, changes use an approved delta/reversal. Update old schema/migrations to this model together; do not just remove uniqueness without an active-pointer constraint.

## DI4 Freeze during atomic fulfilment

Docs describe a PAID-before-FULFILLED race although normal payment success does both in one transaction. A committed intermediate PAID state is not part of the demo contract. Freeze and success compete for the same ordered locks; the winner commits first, the other reevaluates current state. Post-fulfilment freezes use disputes/reversal. Alternate asynchronous fulfilment would require a separate ADR and recovery contract.

## DI5 Frozen credit representation

The old diagram uses FROZEN as a status while prose uses a flag. New drafts use the economic status AVAILABLE/RESERVED/SOLD/RETIRED/REVERSED plus a freeze flag for nonterminal states. Frozen AVAILABLE/RESERVED credits are ineligible. Unfreeze never resurrects voided reservations. Preserve current economic state; display FROZEN as a UI condition, not a second conflicting transition system.

## DI6 Payout minimum terminology

Doc 11 calls S both a sum of net farmer earnings and gross lots. New drafts define `batch_base_paise = sum of releasable farmer-net lots before recovery`; minimum and recovery cap use this base. Sale gross/commission are separate values. Business confirmation of a different minimum basis remains open; display amounts unambiguously and update docs 11/12 together before live settlement.

## DI7 Replacement and commission credit notes

Doc 11 says replacement involves no cash posting but always produces an earnings reversal for invoicing. Doc 09 describes commission credit notes. A commission credit note would affect revenue/payable unless explicitly informational. Do not infer cash effects from a generic reversal event.

Demo core excludes this secondary path. Before implementing it, choose whether replacement retains the original commission or credits it, define matching journal entries and invoice policy, and reconcile earnings/journal/invoice totals. Refund and replacement remedies carry different event types/payloads. This accounting question remains open.

## DI8 Partitioned credit references and deletion lifecycle

Every active uniqueness/FK involving partitioned credits must include vintage or use a reviewed unpartitioned identity table. Feature DTOs carry `{creditId,vintageYear}`. A human credit ID is not permission. Do not partition solely to claim scale; migrations must preserve active allocation uniqueness.

Erasure retains identity-dedup metadata only for its approved retention period. Destroyed subject keys cannot still be required for comparing old sync HMACs; the workflow must return stored statuses for already-recorded IDs and reject new processing for withdrawn subjects. No recreated profile reuses an erased key generation.
