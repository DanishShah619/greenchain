# F13 Blockchain proof and audit integrity

Owners: `audit` and `chain`; E1/E12. Core demo audit, optional Amoy mint/anchor. Inherits [common contracts](common-contracts.md). Audit sequence limitation is [DI2](design-issues.md).

## Audit write and chainer

All mutating use cases call the audit append port in their business transaction. Persist pseudonymous actor/entity/action, minimal payload fingerprint, row MAC and insertion metadata; do not hash raw low-entropy PII. App role cannot delete/edit rows. Chainer alone updates chain columns under fenced lease, processes a stable committed batch, assigns unique committed `chain_seq` and verifies row MACs before chaining. Lease fencing is checked at write, not merely at claim.

The chainer must handle long transactions and horizon lag with timeouts/alerts. Sequence gaps on insertion metadata can reflect rollback and are not tamper proof. Verify hash links, MACs and known anchored heads; state honestly that unchained deletions need an external witness. A compromised DB/admin controlling keys can exceed this threat model. Audit is integrity evidence, not backup or truthfulness of field facts.

## Chain port and state

`ChainPort.submitProof`, `findProof`, `submitAnchor`, `getReceipt` isolate RPC/signer. Chain jobs record domain effect ID, network/contract/version, prepared transaction identity, signer nonce and attempts. Single signer nonce coordination is separate from API scale. Unknown submission first checks prepared tx/proof before allocating a new transaction. Confirmed status follows configured confirmation/reorg policy; dropped/reorged proofs return pending/reconciliation without rolling back a sale.

Only fixed pseudonymous fields and approved head hashes leave the platform. Signer policy restricts chain/contract/method/value; server checks target network and secret environment. No per-farmer wallets or private keys in frontend. Mint idempotency must hold in contract and local effect tables. Contract upgrade/pause is privileged and audited.

## APIs operations and checks

`GET /credits/:id/proof` returns authorised proof status; `GET /admin/audit-verification` returns bounded verification summary. Raw audit exports are permissioned and asynchronous. Resubmit controls select an existing job, never arbitrary transaction calldata or private-key output.

Track audit lag, lease conflicts, chain queue age, RPC errors, nonce/reorg issues and verification mismatch. Keep one active chainer but independently scale other workers. Batch anchors and avoid per-transaction RPC reads in purchase path. Amoy is a testnet; do not claim permanent evidence durability.

Test transaction rollback (no business/audit/job), modified chained row, leader loss/fencing, duplicate mint, uncertain RPC send and chain outage. An outage leaves proof pending while database purchase/statement/certificate remain usable. Production adoption of independently durable audit receipts is an explicit later design task.
