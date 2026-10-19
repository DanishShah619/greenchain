# Versioned synthetic calculations

Implemented 2026-10-14. This slice produces demonstration results only. It does not review a carbon calculation, issue credits, post carry-over balances or submit blockchain proofs.

## Usage

As Field agent / presenter, open **Demo calculation** below a synced case. The case must have `EVIDENCE_APPROVED` status and a matching immutable evidence snapshot. Choose Standard, Cloudy, No uplift or Insufficient simulated evidence, then calculate. Results persist and are also visible read-only in the verifier's case detail. Re-running identical inputs restores the same result.

The server resolves the area from the approved polygon. The user cannot provide a carbon factor, area override, confidence or result. Each run pins the evidence decision, case version, full snapshot, methodology `demo-practice-ndvi-v1`, parameter set `demo-parameters-v1`, fixed fixture scenario and SHA-256 input fingerprint. Run records cannot be updated/deleted through the API and a database trigger blocks row updates/deletes. A result stays immutable when another preset is calculated.

## Arithmetic and assumptions

This uses the placeholder worked example from [document 08](08-mrv-module-design.md), with no claim that the factors or NDVI relationship have scientific validity. It is separate from the production MRV flow, which does not depend on evidence-review decisions.

Two hypothetical practices contribute 0.8000 and 0.5000 tCO2e/ha/demo-cycle, capped at 1.2000. The reference NDVI uplift is 0.2000. `M = clamp((project - baseline) / reference, 0, 1)`; `gross = approved area × capped factor × M`.

Confidence combines synthetic coverage, source quality, baseline-season score and complete-practice-evidence share at weights 0.35/0.25/0.20/0.20. Baseline score is seasons/3, quantized to four places. HIGH >=0.80 uses 10% buffer; MEDIUM >=0.60 uses 20%; LOW >=0.40 uses 30%. Below 0.40 produces a `NEEDS_VISIT` run with no carbon quantity. A negative uplift produces a valid zero result with a flag, not negative tonnes.

All calculation quantities use fixed-scale BigInt arithmetic. Multipliers, confidence, gross and buffer round to four decimal places using half-even. Net equals rounded gross minus rounded buffer, so quantities reconcile exactly. Integer/fractional net tonnes are displayed only; no registry or carry-over transaction occurs.

| Scenario | Project / baseline NDVI | Coverage / quality / baseline seasons | Outcome at 1.25 ha |
|---|---|---|---|
| Standard | 0.62 / 0.50 | 0.75 / 0.90 / 2 | Gross 0.9000; confidence 0.8208; buffer 0.0900; net 0.8100 |
| Cloudy | 0.62 / 0.50 | 0.35 / 0.80 / 1 | Confidence 0.5892; 30% buffer; net 0.6300 |
| No uplift | 0.48 / 0.50 | 0.75 / 0.90 / 2 | Gross/net zero; baseline exceeds project flag |
| Insufficient | 0.62 / 0.50 | 0.10 / 0.60 / 0 | Confidence 0.3850; NEEDS_VISIT; no gross/net quantity |

These scenario values are fixtures, not satellite measurements. The trace and interface label them explicitly. Crop/practice labels supplied during onboarding do not silently select real emission factors.

## Scope and safeguards

Separate `demo_namespaces`, `demo_calculation_runs` and `demo_calculation_receipts` tables isolate fixture results. Only explicitly seeded synthetic namespaces may create runs. No production `carbon_calculations` or issuance queue is populated. Future production registry logic must reject this namespace; demo issuance requires its own explicit demo-only adapter.

Generation is agent-only, scoped to the agent's case and institution. Mandated verifiers may read results. The command holds the case lock, checks expected version and verifies that current boundary/area and original proof hashes still match the approved snapshot. Stale/missing evidence or rejected/unapproved cases are blocked. Stable request IDs reject changed replays; content fingerprints deduplicate identical inputs even under a new request ID. Run, receipt and audit entry commit together.

This is a bounded synchronous demo command, not the planned asynchronous production MRV worker. The reviewed crop-cycle model, published parameter approval, provenance selection, supersession, calibration and scientific validation remain later work. The next product gate is independent review of the exact saved calculation before demo issuance.

## Validation

Nineteen tests passed across the API, offline storage/worker and geometry workspaces. Targeted calculation tests additionally checked namespace denial and blocked result overrides. Type checks and the production build passed. A live approved case produced 0.8170 t gross, 0.0817 t buffer and 0.7353 t net using its polygon area; saved result replay, changed-key rejection, verifier read-only access and the final PWA cache assets were verified. Manual device testing remains deferred by the user.
