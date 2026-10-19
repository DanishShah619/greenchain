# F4 Versioned carbon calculations

Owner: `mrv`; E5. Calculation design is [doc 08](../08-mrv-module-design.md). Scientific validation stays deferred for the demo; production inputs cannot be fixtures. Inherits [common contracts](common-contracts.md).

## Clean boundary and flow

Pure `Methodology.compute(inputs,parameterSet)` produces gross tonnes, confidence, flags and trace; a separate buffer policy returns the withheld share. Application resolves plot/cycle/capture through read ports, loads satellite provenance, pins published parameter/methodology versions and computes in a dedicated queue. MRV does not consume verification decisions. Evidence waivers must already be recorded before it runs.

Use immutable input sets and calculations linked by `supersedes`, not a mutable latest-row flag. Under cycle lock, reject duplicate input fingerprint or link a changed calculation to the former latest. Zero carbon is a valid result; insufficient evidence is NEEDS_VISIT in `mrv_runs`, not a made-up calculation. Post-basis recalculation cannot issue credits automatically.

## Contract

`POST /cycles/:id/calculations` is an authorised enqueue returning 202/runId; normal cycle/evidence triggers enqueue automatically. `GET /cycles/:id/calculation` returns methodology/parameter IDs, input fingerprint, fixed-scale output, confidence/flags and provenance summary. Source files/exact polygons remain scoped. Parameter draft/submit/publish endpoints require separate creator and reviewer; missing factors are permanent configuration errors.

Job key includes cycle, version and stable input identity; changed data must not be coalesced into a running job's old result. Schema validation constrains dates, NDVI ranges, factors, decimals and source origin. Resolve source/fallback buckets before hashing canonical input. Validate units/time basis; do not duplicate annual factors across seasons. Proposed NDVI multiplier remains an assumption.

## Security scalability and durability

Worker reads only owner-exposed views; cannot overwrite calculations or publish parameters. Permit only configured satellite storage/adapters, not user URLs. Limit observation windows and material-change triggers. Cache content-addressed inputs, cap MRV concurrency and isolate CPU-heavy processing from financial workers. Pin inputs before calculation so a mid-job publish cannot change results; lock only DB transitions, not downloads or computation. Recheck current cycle/input version before committing after work outside the lock.

## Demo and acceptance

Demo adapter runs solely in a synthetic scenario and labels output as demonstration. Its events cannot enter production registry queues. Test deterministic results across ordering/decimal scales, crash before/after insert, concurrent changed-input jobs, missing factor/provenance rejection, stale evidence snapshot detection and low-confidence NEEDS_VISIT. Compare traces to worked examples; reproducibility is not scientific accuracy or expert approval.
