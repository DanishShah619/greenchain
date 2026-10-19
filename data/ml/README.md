# Collected ML research data

Collected/prepared 2026-10-13 for West Bengal-focused research. These are real published-source candidate data, not synthetic fixtures. No model trained and no scientific validation/crediting approval claimed.

## What is available

| File | Rows | Appropriate starting use | Important limit |
|---|---:|---|---|
| [West Bengal rice management, 2018](prepared/west_bengal_rice_management_2018.csv) | 1,382 | Retrospective management/yield exploration and feature pipeline | Survey-reported practices/yield; not independent adoption or carbon labels |
| [West Bengal rice gas study extracts](prepared/west_bengal_rice_emissions_study_extracts.csv) | 108 | Candidate seasonal methane/N2O outcome research | 48 Purulia + 60 Burdwan records from two studies; not 108 independent plots |
| [India rice gas study extracts](prepared/india_rice_emissions_meta_analysis.csv) | 645 | Context/transfer comparison after study-level audit | 60 studies; missing gases and local applicability must be respected |
| [Global rice gas study extracts](prepared/global_rice_emissions_meta_analysis.csv) | 5,322 | Larger comparator/pretraining research if justified | Study-extracted/derived data; no automatic transfer to West Bengal |

These sets overlap: West Bengal gas rows are a subset of India, which is a subset of global data. They cannot be concatenated as independent new observations. Keep their source records out of transfer training if reserving them as a local holdout.

## Sources and licences

Management data: Nayak et al. (2024), [Context-dependent agricultural intensification pathways to increase rice production in India](https://www.nature.com/articles/s41467-024-52448-6), DOI 10.1038/s41467-024-52448-6, Supplementary Data 1–2, CC BY 4.0. Publisher ZIP was downloaded, its raw `data` object read without executing supplied R code/models, and only allowlisted West Bengal agricultural columns exported. The paper reports 1,363 analysed West Bengal records; the downloaded source contains 1,382. We retained the source rows and recorded that discrepancy rather than inventing exclusions.

Gas data: Thai et al., [Figshare dataset](https://doi.org/10.6084/m9.figshare.29817482.v1), CC BY 4.0 verified in repository metadata; associated [2026 paper](https://www.nature.com/articles/s44264-026-00136-x). The dataset's licence is distinct from the article's more restrictive licence. Original CSV size/MD5 matched repository metadata; SHA-256 is also recorded. Rows are extracted study outcomes, not acquired raw chamber replicates.

Local study 134 is identified as Purulia by the [original publisher abstract](https://www.sciencedirect.com/science/article/pii/S1574954123000420), DOI 10.1016/j.ecoinf.2023.102013. Study 146 is identified as Burdwan by the [publisher site description](https://www.sciencedirect.com/science/article/pii/S235255092200241X), DOI 10.1016/j.spc.2022.09.001. Both extracts cover 2018–2020. Location was checked against those sources, not inferred solely from a bounding box.

## Privacy and retained provenance

The survey download contained direct identifiers. Farmer names, phone numbers, Aadhaar fields, original IDs, device data, exact coordinates and village fields are excluded from the prepared export. Downloaded survey ZIP/RData/model files were removed after preparation; only source metadata/hashes and scoped agricultural exports remain. This is direct-identifier minimisation, not proof of anonymisation of every possible quasi-identifier. The files are for internal research, not the public demonstration.

Raw/prepared data and local reader dependencies are excluded from Git by the workspace ignore rules. File ignore rules are not access controls. Public gas source data are retained locally for reproducibility; researcher access and publication still follow the project's data-use policy.

Provenance: [source catalogue](source_catalogue.json). Audit: [data quality report](data_quality_report.json). Model input/target exclusions: [task contracts](task_contracts.json). All retained CSVs have hashes and source/origin records.

## Quality findings and model boundaries

- Management data span ten source-labelled districts, all Kharif rice in 2018. Two districts have only 2 and 1 records; they cannot support a context-specific accuracy claim.
- All 1,382 yield values are present and positive; none has a crop-cut label in this subset. Three values are outside an exploratory 0.5–10 t/ha range and two rows share the selected feature/target combination. These are flags, not automatic deletions or verified errors.
- Source nutrient/weather fields are preserved; units, nutrient elemental/oxide conventions, source coding and observation cutoffs need codebook review before model use. Blank strings become missing, not zero.
- West Bengal gas targets are present for all 108 rows. Supplied GWP agrees numerically with `27.9 × CH4 + 273 × N2O` within floating-point tolerance; this checks derived arithmetic, not the original measurements.
- Fifteen West Bengal records reuse an ES_ID within a study; none is an exact duplicate across all source fields. Preserve source-row identity and group related study records; do not deduplicate solely by ES_ID.
- The source meta-analysis can include digitised values, imputed precision/replicate assumptions and reported/derived outcomes. Check original treatment units, gas mass basis, uncertainty and possible shared trials before treating errors as measurement precision.
- Exclude GWP/GHGI, gas targets, outcome SD/SE and yield from inputs when predicting gas emissions. They encode or postdate the target. Survey `L.tonPerHectare` is a duplicate of the yield target, not a feature.
- No split is frozen. Random rows do not provide independent validation when sites/studies/repeated plots overlap. Keep related West Bengal sources together until dependence is resolved.

## Replay

Use the bundled Python or another environment with pandas/numpy and the workspace-pinned reader dependencies in [requirements](../../scripts/research-data-requirements.txt). Environment versions used here are recorded in the quality report.

`python scripts/collect_ml_training_data.py` downloads the pinned publisher ZIP and repository CSV, verifies source content, prepares exports and removes identifier-bearing temporary survey files in a finally block. It requires public network access. `prepare_ml_training_data.py` is the preparation module; it needs the temporary source supplied by the collector. The supplied R model/SHAP file is never executed or loaded for training.

## What still needs collecting

Government catalogue audit: [AIKosh source review](aikosh-source-review.md) adds ICAR field imagery, agricultural-knowledge benchmarking, landscape and irrigation candidates omitted from the first search. These are discovery records, not downloaded datasets; current file access, licence and local applicability still need verification.

Paired SOC stock-change records with management/control and lab uncertainty; independent practice observations paired to plot satellite histories; labelled phone evidence images; crop/season ground truth suitable for field inference. We have not substituted survey reports, generated maps or formula outputs for those labels.

Other leads: the earlier CIMMYT 2018 survey is publicly listed but reuse terms are unspecified and API access returned 403; KARC image data have an author download link but dataset-specific licence/split provenance are not yet verified; the local rice–rice SOC paper offers data on author request. They are not represented as acquired/licensed training data. No author messages were sent.
