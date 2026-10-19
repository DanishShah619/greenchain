# E14 Allocation research evaluation

Owner: a separate offline evaluator depending on pure FCAE contracts and pseudonymous fixture/export schemas. It has no writable production repository or financial ports. Optional demo comparison view. Inherits [common contracts](common-contracts.md).

## Reproducible inputs and baselines

`GenerateScenario`, `RunAlgorithm`, `CompareBaselines`, `SummariseRun`. Store seed, generator/algorithm/policy versions, farmer-group inventories/tiers, order stream, timing/expiry policy and run hash. Compare FCAE, FCFS and reputation-only against identical admissible inputs. Baselines must follow identical supply, paid/expired-order semantics and any constraints selected for a fair comparison; disclose intentionally different caps and run ablations separately.

Measure Gini, explicit-window starvation rate, max waiting, allocation/DB latency where measured, fulfilment completeness and commission-adjusted income. State whether outcomes are weighted by farmers, payee groups or available inventory. No inference that positive weights prove bounded starvation. Repeated seeds/intervals and small-order/cap-discontinuity scenarios expose variability.

## Interface and execution

`GET /research/runs` and `/research/runs/:id` display precomputed synthetic reports. Optional `POST /research/runs` is presenter/researcher-only with bounded population/order count/seed and supported parameter keys. Queue CPU-intensive runs separately; no in-browser unbounded computation or public arbitrary code execution. Result includes dataset identity, comparison method, counts, definitions and limitations, not only flattering charts.

Production allocation exports are asynchronous, permissioned and strip identity, exact geometry, bank information and private incident evidence. Integrity hash/version ensures the evaluator cannot silently change order inputs. Synthetic exports are preferable for the public demo; actual earnings outcomes remain in transactional owner views.

## Scale security and acceptance

Run in bounded chunks/streaming aggregations, cap memory/runtime and persist checkpoints where justified. Process isolation protects API/financial queues. Store immutable run outputs with retry effect key; a failed run has explicit error/progress and never changes inventory. Metrics distinguish pure allocation timing from database lock/query timing.

Test hand-computed Gini/fulfilment cases, all-zero populations with defined metric handling, reproducible seeds, shuffled inputs, skewed tiers/supply, repeated expired orders, new group entry and baseline parity. Do not tune and evaluate on the same scenarios without disclosure. Literature review and novelty claim remain a research gate, separate from demo completion.
