# 08 · MRV Methodology Module — Design

Status: Draft v3 (revised after two technical reviews; **not yet implemented**) · Implements D15 · Related: [06-technical-design.md](06-technical-design.md) §3, §5, §7 · [04](04-feature-flows-and-failure-modes.md) F4 · Stories S5.1–S5.4, S7.1 in [05](05-backlog-story-points.md).

> **All numeric factors, weights and band edges in this document are PLACEHOLDERS.** They are not sourced emission factors. Sourcing is spike SP-2 / Q-OQ-14.

---

## 1. Classification and context
- **Component type:** async worker; one job per crop cycle. The calculation itself is a pure, versioned function the worker calls.
- **Load:** ~750K plots, 1–2 cycles per plot per year ≈ 1.5M jobs/yr; bursts only when a satellite export is refreshed. The problem is correctness and traceability, not throughput.
- **Stack:** Node + TypeScript modular monolith; Postgres job queue (`SKIP LOCKED`, pg-boss style); single worker process; no Redis in the MVP.

## 2. Scientific stance (research clarification, 2026-10-12)
> NDVI measures vegetation greenness. It is not a direct measurement of soil organic carbon or universal proof that a farming practice occurred. The practice-factor and NDVI-multiplier formula below is an experimental hypothesis whose parameters and predictive validity remain unapproved.

This narrows the earlier claim that greenness establishes practice adoption. Sensor interpretation: [USGS NDVI documentation](https://www.usgs.gov/landsat-missions/landsat-normalized-difference-vegetation-index). The [West Bengal research protocol](research/west-bengal-research-protocol.md) defines independent measurements, comparators and review gates. It does not change the experimental arithmetic or authorise real issuance. Raw NDVI validity/scaling is sensor-specific and may include negative values; the proposed vegetation feature range in section 4 requires an explicit processing/exclusion policy, not silent clipping of raw observations.

## 3. Module boundaries and layout

```
src/modules/mrv/
  index.ts            public API: enqueueCalculation(), event types
  domain/             PURE, no I/O (lint-enforced)
    compute.ts        compute(inputs, params) → {gross_co2e, confidence, trace}
    sequestration.ts  ndviMultiplier.ts  confidence.ts  buffer.ts
    decimal.ts        canonical.ts (inputs_hash)  errors.ts
  application/        calculateCycle.ts  selectNdvi.ts  provenance.ts
  infra/              repositories, pg-boss worker, ports (LandRead, CaptureRead)
  http/               admin + read routes
docs/methodology/practice-ndvi-v1.md
```

- `compute` honours the contract in 06 §7.5; `buffer(confidence, params)` is a separate pure function so the contract stays unchanged.
- `calculateCycle` is the only impure orchestrator: resolve inputs → check provenance → lock → compute → insert → emit.
- Ports supply the cycle, area, `plot_hash`, **claimed practices with their evidence-slot status** (from `capture`) and `media_complete`. `mrv` never consumes verifier decisions: the flow is mrv → verification, so there is no dependency back (see also doc 10 §4). No other module's tables are imported (06 §1); the `mrv_worker` DB role reads other modules only through read views exposed by their ports.
- **Enqueue triggers (all go through the `mrv` queue, see §7):** cycle end **and** `media_complete` (S3.2); a **material change** in the selected observation set; or an admin request. A raw NDVI refresh does not by itself enqueue a job.

## 4. Formula — methodology `practice_ndvi`, v1

| Symbol | Meaning | Unit |
|---|---|---|
| A | plot area | ha, 4 dp |
| f_p | factor for verified practice p, keyed (practice, crop, soil, zone), from the parameter set | tCO₂e/ha/cycle |
| S | `min(Σ f_p, cap)`; stack cap is a parameter | tCO₂e/ha/cycle |
| N_proj | mean of gap-filled NDVI over the cycle window | 0..1 |
| N_base | median of seasonal means, same plot and season, up to 3 prior years | 0..1 |
| Δ_ref | reference uplift per (crop, zone), from the parameter set | NDVI units |
| M | `clamp((N_proj − N_base) / Δ_ref, 0, 1)`, quantised to 4 dp | dimensionless |

`gross_co2e = A × S × M` (tonnes).

- **Arithmetic:** `decimal.js` with a fixed context; no JS floats in `domain/`. Quantise M to 4 dp (ROUND_HALF_EVEN), multiply, round the result once to 4 dp (HALF_EVEN) to match `NUMERIC(12,4)`.
- **Clamp:** `N_proj < N_base` ⇒ M = 0, gross = 0, flag `BASELINE_EXCEEDS_PROJECT`.
- **Missing parameter** (f_p, Δ_ref, zone) is a permanent error; there is no default.
- **Parameter validation at publish time** (not at compute time): `Δ_ref > 0`, every `f_p ≥ 0`, `cap ≥ 0`, expected buckets `> 0`, confidence weights sum to 1, band edges strictly ordered. A parameter set violating any rule cannot be submitted for review. Division by zero is therefore impossible by construction.
- **Fewer than 1 baseline season:** N_base is taken from the zone reference value in the parameter set; `s_base = 0` then follows from the formula (no separate rule).
- `s_prac` uses **claimed practices with complete evidence slots**, not verifier-confirmed practices (verification happens after this module).

**Worked example (PLACEHOLDER numbers):**
```
A = 1.2500 ha; f_p1 = 0.80, f_p2 = 0.50; cap = 1.20  →  S = min(1.30, 1.20) = 1.20
N_proj = 0.62, N_base = 0.50, Δ_ref = 0.20            →  M = 0.6000
gross = 1.2500 × 1.20 × 0.6000 = 0.9000 t
```

## 5. Confidence and buffer
Confidence = Σ wᵢ·sᵢ, rounded to 4 dp. Weights and bands are PLACEHOLDERS in the parameter set (Q-OQ-1).

| Component | Weight | Definition |
|---|---|---|
| s_cov | 0.35 | clean 10-day buckets ÷ expected buckets; an interpolated bucket counts 0.5 |
| s_src | 0.25 | mean source quality over used observations: Sentinel-2 1.0, Landsat-9 0.8, Bhuvan 0.6 |
| s_base | 0.20 | `min(baseline seasons / 3, 1)` |
| s_prac | 0.20 | share of claimed practices whose required evidence slots are complete (not verifier-confirmed; verification happens after this module) |

| Confidence (rounded to 4 dp, then lower-inclusive) | Band | buffer_pct (placeholder) |
|---|---|---|
| ≥ 0.80 | HIGH | 0.10 (the 06 §7.4 default) |
| 0.60 – < 0.80 | MEDIUM | 0.20 |
| 0.40 – < 0.60 | LOW | 0.30 |
| < 0.40 | none | no calculation; outcome `NEEDS_VISIT` |

Example: s_cov 0.75, s_src 0.90, s_base 0.6667, s_prac 1.0 ⇒ confidence 0.8208 ⇒ HIGH ⇒ buffer 0.10 ⇒ net 0.8100 t. That is below one whole credit, so the amount goes to `plot_carry_over` (06 §7.2).

## 6. Data model (new or changed; PKs UUIDv7)

```sql
parameter_sets(id, methodology, version int, params jsonb, params_hash,
  status CHECK IN ('DRAFT','IN_REVIEW','PUBLISHED','RETIRED'),
  created_by, approved_by, published_at,
  CHECK (status <> 'PUBLISHED' OR (approved_by IS NOT NULL AND approved_by <> created_by)),
  UNIQUE (methodology, version));
-- trigger: `params`, `params_hash`, created_by never change after submit; once PUBLISHED only the
-- transition PUBLISHED -> RETIRED is allowed. Validation rules of §4 run at DRAFT -> IN_REVIEW.

methodology_versions(id, methodology, mrv_version text,
  parameter_set_id FK NOT NULL, status, created_by, approved_by, effective_from, doc_ref,
  CHECK (status <> 'PUBLISHED' OR (approved_by IS NOT NULL AND approved_by <> created_by)),
  UNIQUE (methodology, mrv_version, parameter_set_id));
-- constraint trigger: parameter_set_id must reference a PUBLISHED parameter set when the methodology version is published

ndvi_input_sets(id, content_hash char(64) UNIQUE, plot_hash, window_start, window_end,
  observations jsonb, summary jsonb);        -- content-addressed: identical inputs are stored once

carbon_calculations(id, cycle_id, methodology_version_id FK NOT NULL, parameter_set_id FK NOT NULL,
  input_set_id FK NOT NULL, inputs_hash char(64) NOT NULL,
  gross_co2e, confidence, buffer_pct, supersedes FK NULL,
  trace jsonb NOT NULL,                      -- compact: symbols and intermediate values only, not the observations
  flags text[] NOT NULL DEFAULT '{}', inputs_origin text[] NOT NULL,
  CHECK (confidence BETWEEN 0 AND 1), CHECK (gross_co2e >= 0),
  CHECK (NOT ('FIXTURE' = ANY(inputs_origin))),
  UNIQUE (cycle_id, methodology_version_id, inputs_hash));
-- UPDATE/DELETE revoked + trigger: rows are immutable and no flag is ever flipped

issuance_basis(basis_id PK, cycle_id FK, calc_id FK, verification_id FK, selected_by, at);
cycle_verification_state(cycle_id PK, active_basis_id FK, generation bigint); -- one active unrevoked basis; cycle-locked pointer   -- owned by `verification` (doc 10 §4); specified here because mrv and registry depend on it
-- append-only; written in the transaction that records the verifier decision VERIFIED, which carries the calc_id it reviewed and is rejected if that calculation is no longer the latest; a basis can be withdrawn before issuance only by an append-only issuance_basis_revocations row (06 §3)

mrv_runs(id, cycle_id, methodology_version_id, inputs_hash, outcome, reason,
  calc_id NULL, attempts, created_at);        -- append-only outcome log

ndvi_observations(+ origin CHECK IN ('GEE_EXPORT','BHUVAN','FIXTURE'), export_id, scene_id);
```

- `mrv_runs` exists because `NEEDS_VISIT` and permanent failures create no calculation row.
- **Why `issuance_basis` instead of an `is_issuing` flag:** a flag fixed at INSERT would make the first calculation (possibly on partial NDVI) the issuing one and strand better data. Calculations stay immutable; the *verifier decision* selects which calculation is the basis, so the reviewed row is exactly the issued row (06 §7).
- **Growth control:** observation sets are stored once by content hash and referenced; `trace` keeps only symbols and intermediates, so a refresh that changes nothing adds no data and a material change adds one small calculation row.
- **Definition of "latest":** the calculation for a cycle that has no successor in the `supersedes` chain. The job sets `supersedes` to the previous latest at insert time, under the cycle lock, so order is defined by the chain, not by insertion time or fingerprint.
- **After a basis exists**, a new calculation is still computed on a material change but is flagged `POST_BASIS`; it reaches credits only through an admin-approved delta (`issuance_deltas`, 06 §7.3). A revoked basis re-opens the cycle for a new verification decision.
- **Invariants:** immutable rows; one active unrevoked issuance basis per cycle; confidence ∈ [0,1]; gross ≥ 0; never written from mock or provenance-mismatched data; every row stores `inputs_hash` and references its input set.

## 7. Job lifecycle

```
ENQUEUED → RUNNING → CALCULATED            (calc row + CalculationCreated event)
                   → NEEDS_VISIT           (mrv_runs row, no calc, task event)
                   → REJECTED_PROVENANCE   (mrv_runs row, alert, no retry)
                   → FAILED_PERMANENT      (dead-letter, admin task, no retry)
                   → RETRY (transient) → RUNNING   max 5 failure attempts, backoff, then dead-letter
                   → DEFERRED_LOCKED       (cycle lock held; delayed requeue, separate counter, alert after 20)
```

1. **Queue and triggers:** a dedicated `mrv` queue with a concurrency cap (default 4 **[A]**), so MRV bursts can never starve invoicing or payouts. Jobs are enqueued at cycle end (+ `media_complete`), on a material change (a cheap pre-check compares the new observation set's derived M and confidence with the last calculation; threshold configurable), or by an admin.
2. **Job key:** `cycle_id : methodology_version_id : input_fingerprint`, where the fingerprint is the content hash of the observation set selected at enqueue time. A refresh with different data therefore enqueues a *different* job instead of being silently dropped by the queue's singleton rule; identical data deduplicates.
3. **Pin:** `methodology_version_id` and `parameter_set_id` are pinned in the payload.
4. **Resolve inputs:** per 10-day bucket take the first source in the chain (S2 → L9 → Bhuvan) with `cloud_pct ≤ max_cloud`; interpolate gaps ≤ `gap_max` days.
5. **Provenance:** every observation must have `plot_hash == land_plots.plot_hash` and `origin != FIXTURE`; any mismatch rejects the run and alerts.
6. **Canonicalise and hash:** the canonical JSON has sorted keys; decimals as strings with fixed scale (NDVI 4 dp, area 4 dp, cloud_pct 2 dp, so `0.5` and `0.50` hash identically); dates as ISO-8601 UTC. **Included (everything that can change the result):** area A, the plot's keyed `plot_hash`, the **resolved 10-day buckets after source-chain selection and interpolation** (bucket start, chosen source, NDVI, interpolated flag), the baseline seasons, **per-practice evidence flags** (claimed practice → required slots complete or not, which drive `s_prac`), `methodology_version_id`, `parameter_set_id` and the cycle window. **Excluded:** `export_id`, fetch timestamps, URLs, anything volatile. SHA-256 of that JSON is `inputs_hash`; two inputs that produce a different confidence or amount can never collide.
7. **Lock:** `pg_try_advisory_xact_lock(class_mrv, hash(cycle_id))` — a two-key lock so the namespace is disjoint from the registry's `(class_registry, credit_type)` locks. If held, requeue with delay and a separate contention counter; contention never consumes the 5 failure attempts.
8. **Compute and insert:** `compute` → `buffer` → `INSERT … ON CONFLICT (cycle_id, methodology_version_id, inputs_hash) DO NOTHING`; the input set is upserted by content hash first.
9. **Emit:** write the `mrv_runs` row and the outbox event in the same transaction.

**Linking to issuance:** the verifier reviews the *latest* calculation; the decision carries its `calc_id`, takes the **same `class_mrv` cycle lock** as the job, and is rejected if that calculation is no longer the latest (the verifier then re-reviews). `VERIFIED` writes `issuance_basis` naming exactly that calculation. A basis can be withdrawn before issuance (appeal, spot-check failure, dispute) by an `issuance_basis_revocations` row, which the registry re-checks under its lock. Any calculation created after the basis exists reaches credits only through the admin-approved delta path (06 §7.3). A correction before verification is simply a newer calculation that the verifier then sees; no row changes.

## 8. Authorization

| Principal | Allowed |
|---|---|
| `mrv_worker` | SELECT on **module-owned views** (cycles and area from `land`, claimed practices and evidence-slot status from `capture`, NDVI observations); INSERT on `carbon_calculations`, `ndvi_input_sets` and `mrv_runs`; no UPDATE or DELETE |
| Admin (author) | create DRAFT parameter sets, submit for review |
| Admin (second reviewer, ≠ author) | approve/publish parameter sets **and** methodology versions (the two-person rule is a CHECK on both tables); audited |
| Verifier | read calculation, trace, confidence, flags for plots in their mandate; cannot alter inputs |

## 9. API / admin surface

| Endpoint | Role | Purpose |
|---|---|---|
| `POST /admin/mrv/parameter-sets`, `…/:id/submit`, `…/:id/approve` | admin / second admin | draft, review, publish |
| `POST /admin/mrv/methodology-versions/:id/publish` | admin | bind code version to a parameter set |
| `POST /admin/mrv/cycles/:id/recalculate` | admin | enqueue against a chosen version, with reason |
| `GET /admin/mrv/runs`, `GET /admin/mrv/dead-letters`, `POST …/:id/requeue` | admin | triage |
| `GET /cycles/:id/calculation` | verifier (mandate-scoped) | calculation, trace, confidence, flags |
| `GET /methodology/:version` | authenticated | published methodology document |

## 10. Test plan
- **Golden (S5.4):** versioned fixtures (including the worked example) assert exact string outputs and `inputs_hash`; a nightly canary re-runs them against every PUBLISHED version; a changed hash raises the per-version drift alert.
- **Property tests:** determinism (shuffled observations ⇒ identical result); monotonicity (gross non-decreasing in A, each f_p and N_proj; confidence non-decreasing in each component; buffer_pct non-increasing in confidence); bounds (0 ≤ M ≤ 1, gross ≥ 0, confidence ∈ [0,1]); rounding (≤ 4 dp).
- **Failure injection:** kill worker between compute and insert, then re-run ⇒ exactly one row; deliver the job twice concurrently ⇒ one row; publish a new parameter set mid-flight ⇒ pinned version used; FIXTURE-origin or `plot_hash`-mismatched observations ⇒ rejected; unknown zone ⇒ dead-letter, no default; all-cloud series ⇒ `NEEDS_VISIT`, no row; N_base > N_proj ⇒ gross 0 + flag; an NDVI refresh arriving while a job for the same cycle is running ⇒ a second job with a different fingerprint is enqueued, not dropped; two simultaneous `VERIFIED` decisions for one cycle ⇒ cycle lock/pointer generation permits one active basis; revocation before issuance permits a new immutable basis; a parameter set with `Δ_ref = 0` ⇒ rejected at submit; same data with different decimal scale ⇒ same `inputs_hash`; identical refresh ⇒ no new row and no new input set.

## 11. Observability
- **Logs:** structured with `cycle_id`, `methodology_version_id`, `inputs_hash`, `outcome`, `duration_ms`, `trace_id`; at start, outcome and dead-letter.
- **Metrics:** queue lag and oldest-job age; duration p95; retry and dead-letter rate; confidence histogram; fallback-source ratio; provenance rejections; output-drift alert per version.
- **Health:** age of the last successful calculation; alert only when the queue is non-empty (off-season quiet is normal).

## 12. Build sequence (small steps)
1. Migrations: `parameter_sets`, `methodology_versions` (with the PUBLISHED-parameter-set constraint trigger), `ndvi_input_sets`, `mrv_runs`, new `carbon_calculations` columns and constraints, roles, immutability triggers. (`issuance_basis`, its revocations and `issuance_deltas` are created in the `verification`/`registry` modules' migrations, which own them.)
2. `decimal.ts` and `canonical.ts` with hash tests.
3. `sequestration`, `ndviMultiplier`, `compute`, golden tests and the worked example (S5.1, S5.4).
4. `confidence` and `buffer` with property tests (S5.3).
5. `selectNdvi` and `provenance` over a fixture-backed port (S5.2).
6. `calculateCycle` orchestrator with advisory lock, insert and outbox event.
7. pg-boss worker, retry and dead-letter policy, failure-injection suite.
8. Admin publish/review flow and the verifier read endpoint.
9. Metrics, health, nightly drift canary.
10. Methodology doc after SP-2 sources are chosen; hand-off to S7.1 issuance.

## 13. Open questions (need the project owner)
| # | Question | Blocks |
|---|---|---|
| M-1 | Which published sources back f_p, Δ_ref and the stack cap (IPCC tier tables, ICAR or other studies)? Everything is a placeholder until chosen (SP-2, Q-OQ-14). | Steps 3, 10 |
| M-2 | Who is the second reviewer for parameter-set publication, and what is the fallback for a two-person team? | Step 8 |
| M-3 | Confirm confidence weights, band edges and the minimum-confidence threshold (Q-OQ-1). | Step 4 |
| M-4 | Should M have a floor? Zero uplift currently means zero credit, which is conservative for fields already at high NDVI. | Step 3 |
| M-5 | Is f_p per crop cycle or per year? Multi-season and vintage-spanning cycles need a rule. | Step 3 |
| M-6 | *Resolved in v2:* there is no `is_issuing` flag; `issuance_basis` is written by the verifier decision, and corrections before verification are simply newer calculations. Confirm. | Step 6 |
