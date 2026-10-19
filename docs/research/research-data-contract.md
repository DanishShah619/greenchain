# Research intake and reproducibility contract

Status: proposed, 2026-10-12. Applies to West Bengal carbon/evidence research. Missing required observations are UNKNOWN, never fabricated zero or a model-derived measurement.

## Dataset manifest

Record `dataset_id`, version, origin (MEASURED / PUBLISHED_AGGREGATE / SYNTHETIC), source DOI/URL, licence/allowed use, acquisition date, context definition, unit of analysis, sample/cluster counts, inclusion/exclusion policy, data/code hashes, reviewer, split manifest, and whether any rows influenced factor selection/training. A data-use approval is separate from a scientific approval.

## Monitoring interval table

Required identifiers/fields: `study_id`, pseudonymous `site_id`, `block_id`, `plot_id`, monitoring interval ID, start/end dates, area_ha, soil/context class, crop sequence, irrigation condition, treatment/control assignment, management history, practice bundle/version and independently observed adoption status. Preserve assignment and actual practice separately.

SOC layers record sampling time and layer boundaries, SOC_g_per_kg, bulk_density_Mg_per_m3, coarse_fragment_fraction and its definition, assay/preparation methods, organic/inorganic separation, core/replicate IDs, uncertainty units/type and QA flags. Store measured concentrations separately from derived stocks. Equivalent-soil-mass calculations have versioned reference mass/interpolation and input provenance.

Gas records include plot/time, gas species and mass basis, flux units, measurement method, calibration, chamber/site replicate, raw observations, water/fertiliser/rainfall events and integration procedure. Management inputs include fertiliser N amounts/form/timing, organic amendment dry mass/carbon content/origin, residue handling, fuel/electricity and yield with units/measurement method.

Satellite features record geometry version, sensor/product/processing version, acquisition and availability times, cloud/shadow policy, valid pixel count/fraction, time gaps, observed versus imputed values and feature cutoff. Keep private geometry under scoped processing access. Sentinel-2-era inputs cannot be assumed available for an older experiment; period/sensor compatibility is a data-access gate.

## Evaluation table

One row per agreed analysis unit: ID/context/split, observed target and unit/time basis, measured uncertainty, model/version, prediction, lower/upper interval and nominal coverage, abstention/reason, feature/input snapshot hashes and evaluation code version. Do not invent observations from the model's factor table.

Check unit/time/depth compatibility before joining. Treatment/control pairing and repeated-plot groups must be preserved. Duplicate rows, impossible dates, ambiguous gas mass basis, incompatible SOC layers or absent provenance are intake failures. Quality flags do not automatically justify exclusion; record the reviewed policy and exclusion counts.

## Release artifacts

Save raw permitted data read-only; transformed dataset; source and exclusion logs; split/seed manifest; frozen parameters/code/environment; metrics with counts/units and uncertainty; reviewer comments; limitations; content hashes. Training/calibration/holdout IDs must not overlap at the relevant site/plot group level. A replay reproduces inputs and results without touching operational issuance or money.

Scientific training copies follow consent, retention and erasure obligations. Published aggregate tables and synthetic fixtures have separate origin labels; they must not be combined with measured holdouts under a generic “ground truth” label.
