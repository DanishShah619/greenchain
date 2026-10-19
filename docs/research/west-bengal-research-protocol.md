# Scientific research protocol: West Bengal agricultural carbon

Prepared 2026-10-12. Status: draft protocol for domain review; no field dataset acquired, specialist endorsement, trained model or independent prediction validation. Geographic focus follows the project owner's instruction: Indian crops and farming practices focused on West Bengal. Complements the [ML workflow](../15-ml-workflow-design.md), [MRV evidence review](mrv-evidence-review.md) and [system design](../15-system-design.md).

## 1. Research questions and contribution

Primary question: can a context-specific, traceable estimation workflow quantify management-related carbon-stock changes or net greenhouse-gas mitigation in West Bengal, with defensible uncertainty and explicit abstention outside validated contexts?

Secondary question: do satellite features add predictive or verification value beyond management records and context-matched practice baselines? This question tests the proposed NDVI multiplier; it does not assume the multiplier is correct.

Separate three study outputs:

1. Agronomic effect estimation: treatment versus a defined baseline, including possible adverse effects.
2. Prediction validation: frozen estimates compared with independent measurements on held-out sites/intervals.
3. Credit eligibility: additionality, permitted boundary, leakage and permanence under a separately reviewed methodology. Good prediction alone does not establish eligibility.

A defensible initial contribution is a reproducible evidence-to-estimate pipeline and evaluation, including negative findings. Do not claim a new soil-carbon measurement technique or nationwide validity merely because software joins existing data sources. FCAE fairness is a separate computational research track described in [E14](../features/18-research-evaluation.md); it cannot validate agricultural carbon amounts.

## 2. West Bengal context matrix

The following are candidate study strata and practice hypotheses, not confirmed pilot sites, adoption statistics or recommendations to change farmers' management. Final sites depend on accessible independent measurements and partners.

| Context candidate | Practices to investigate | Measured outcome and major confounders | Priority |
|---|---|---|---|
| Managed irrigated rice, preferably a documented boro season | Controlled water management/AWD; nutrient management | Seasonal CH4 and N2O, pumping inputs, water and grain yield; actual drainage control | First candidate for a seasonal GHG study if instrumentation is available |
| Rice–rice in red/lateritic conditions | Residue and organic-input bundles with balanced nutrients | Multi-year SOC stock change, bulk density and rice GHG; amendment source and previous management | First candidate for SOC literature/data audit |
| Alluvial rice-based rotations, including rice–wheat where locally documented | Nutrient/organic-input bundles; reduced tillage in appropriate rotation stages | Rotation-level SOC and input/emission changes; puddling and treatment interactions | Parallel literature candidate |
| Rice–potato / rice–mustard / rice–pulse rotations | Nutrient, residue and rotation management | Whole-rotation balance and yield; crop sequence and imported inputs | Expand after a dataset audit |
| Jute–rice rotations | Nutrient, residue and water-management evidence | Whole-rotation SOC/GHG; retting or product processes require separately defined boundaries | Later context-specific study |
| Coastal/saline or flood-prone rice | Only practices feasible under local water/soil conditions | Salinity, tidal/flood water control and crop damage | Separate support boundary, not pooled automatically |

Local relevance is supported by [ICAR's West Bengal overview](https://www.icar.gov.in/en/node/17296), which identifies rice, potato, mustard, pulses and jute, and [ICAR-CRIJAF outreach](https://icar.gov.in/index.php/en/icar-crijaf-leads-viksit-krishi-sankalp-abhiyan-west-bengal), which discusses rice and nutrient-management practices. Those pages are context sources, not current area estimates or carbon factors.

District is metadata, not a sufficient scientific stratum. Record soil, irrigation control, crop sequence, season, amendment history and baseline practice. A model validated in one alluvial irrigated context does not automatically cover lateritic rainfed or coastal saline plots.

## 3. Evidence inventory and current access

See the [West Bengal evidence catalogue](west-bengal-evidence-catalogue.md). Initial leads include a local 25-year rice–wheat organic-amendment experiment and a local rice–rice nutrient-management paper. They support auditing treatments and stocks; they do not yet supply an approved transferable factor.

An AWD water-productivity paper is a lead for management/water outcomes. Water savings must not be converted into methane savings without measured emissions or an independently justified emissions model. A West Bengal CH4/N2O paper is a gas-measurement lead, currently awaiting primary full-text verification.

The previous Sapkota Bihar benchmark stays a worked arithmetic example and external-comparison lead, not a West Bengal calibration factor. Sources used to select factors cannot also count as independent holdout validation. Data availability, permission, raw replicates and exact sites must be checked before selecting models.

## 4. Measurement targets and dimensional accounting

SOC study unit: a plot monitoring interval spanning known dates, potentially several rotations. Seasonal gas study unit: plot × growing season, with a defined annual/rotation boundary if combined with SOC. Never relabel an annual rotation factor as a per-crop factor twice.

For a fixed-depth mineral-soil layer, a proposed dimensional calculation is:

`SOC_stock_tC_per_ha = SOC_g_per_kg × bulk_density_Mg_per_m3 × depth_m × 10 × (1 − coarse_fragment_fraction)`

Sum comparable layers. The conversion assumes the SOC and bulk-density definitions are compatible with the fine-earth/coarse-fragment correction; the lab/specialist must confirm whether a correction is already included. Do not apply it twice. Fixed-depth versus equivalent-soil-mass comparison must be reviewed when density changes between treatments/times.

`treatment_delta = stock_end − stock_start`

`control_adjusted_delta = treatment_delta − matched_control_delta`

`SOC_related_CO2 = control_adjusted_delta × 44/12`

These are stock-change calculations, not a complete crediting formula. A before/after control contrast requires a valid experimental/counterfactual design; it does not automatically eliminate weather, selection or management confounding. Preserve negative values for analysis. Report the actual interval; any annualisation is a descriptive average, not proof of the same rate each year.

Net mitigation, with all terms on a common area/time basis:

`net_CO2e = SOC_related_CO2 + (baseline_nonSOC_GHG − project_nonSOC_GHG) − leakage`

The non-SOC terms explicitly cover included CH4, N2O, fuel/electricity, amendment/input pathways and other chosen sources without double counting. Gas mass units must state CH4 versus CH4-C and N2O versus N2O-N. Conversion uses a pinned GWP horizon and source/version. Do not add overlapping bundled factors or count harvested biomass as persistent soil storage.

[IPCC AFOLU guidance](https://www.ipcc-nggip.iges.or.jp/public/2019rf/vol4.html) is a methodological reference for crop/soil and managed-soil emissions. Inventory guidance is not, on its own, approval of a project crediting method.

## 5. Hypotheses, comparators and rejection criteria

| ID | Testable hypothesis | Comparison | Evidence that rejects or limits it |
|---|---|---|---|
| H1 | A locally matched practice/context baseline predicts measured SOC change adequately | Published/local baseline vs independent stocks | Bias/error/interval coverage outside pre-agreed limits |
| H2 | Satellite features improve out-of-site prediction over management/context alone | Same holdout: practice-only vs satellite-assisted | No practically meaningful gain, worse bias or degraded subgroup coverage |
| H3 | The current clamped NDVI multiplier improves estimation | Frozen doc 08 formula vs no-multiplier baseline | Worse error, systematic zero estimates for measured gains, or context instability |
| H4 | A practice-specific evidence model assists review | Rules vs classifier on independent observed labels | Excess false flags, poor calibration or unacceptable burden at a fixed visit budget |
| H5 | A selected management change reduces net GHG while meeting the agreed yield constraint | Treatment/control net boundary and yield | Gas/input tradeoffs eliminate benefit or yield falls beyond the pre-agreed margin |

Do not predeclare that all five must be positive. A result rejecting H3 can still improve the system by replacing an unsupported assumption through a separately reviewed methodology revision.

NDVI measures vegetation greenness; it is not direct SOC measurement or universal proof of a practice. [USGS NDVI documentation](https://www.usgs.gov/landsat-missions/landsat-normalized-difference-vegetation-index) explains its spectral/vegetation interpretation. Test crop and practice signals against independent field observations, with season/weather effects and mixed-pixel limitations recorded.

## 6. Sampling and independent labels

Prefer a randomised, blocked treatment/control field design where partners and agronomic feasibility permit. Otherwise declare an observational design, document matching/covariates, inspect overlap and acknowledge unmeasured confounding. A simple adopter/non-adopter correlation is not causal proof.

For SOC, collect starting/final layer stocks using consistent depth/mass conventions, sample locations, soil preparation and lab methods. Record SOC concentration, bulk density, coarse fragments, replicates and precision. Separate organic from inorganic carbon where the assay/context requires it. A baseline concentration map alone cannot validate temporal stock change. Take paired follow-up samples in comparable seasonal conditions; specialist review determines depth, core count, laboratory QA and detectable-change horizon.

For seasonal rice gases, use a specialist-reviewed flux protocol with timestamps, chamber/measurement details, calibration, spatial replication and sufficient coverage around irrigation, fertiliser and rainfall events. Preserve raw fluxes and the integration method. Few convenient spot samples must not masquerade as seasonal emissions totals.

Independent adoption labels require dated visits/records indicating confirmed, contradicted or unknown practice status. NDVI-derived labels cannot validate an NDVI-based classifier. Verification decisions can be operational outcomes; they are not automatically independent scientific truth. Keep a random audit sample so high-risk queue selection does not bias every label.

Sample size comes from pilot variance, smallest useful effect, treatment/control pairing, clustering, desired power and expected attrition. Do not invent a universal 30-plot or 100-plot requirement. Prepare a power/sensitivity analysis after variance data and costs are available; multi-year SOC detectability and a seasonal gas study have different timelines.

## 7. Frozen datasets and analysis

Use the [data intake contract](research-data-contract.md). Each dataset release has permitted-use metadata, source/assay versions, exclusions, analysis unit, raw-input hashes and a split manifest. No real names, phone numbers or bank information belong in analysis exports. Exact plot locations/media require scoped processing access.

Split by independent site/farm/experimental block as appropriate; keep repeated samples/cycles from the same experimental unit together. Reserve an external site/context and, where feasible, a future period. Fit transforms, imputation, model parameters and uncertainty calibration only on training/calibration data. No synthetic or model-derived label belongs in the measured holdout.

Comparators: a context-matched published/management baseline; the current frozen NDVI formula; a simple management/context regression when sample support permits; the same model plus satellite features. Compare on identical eligible holdouts and report abstentions separately. A complex ML model is not required if data are insufficient.

Primary regression metrics: signed bias, MAE, RMSE, prediction-interval coverage and width, with explicit tC or tCO2e per hectare per monitoring interval. Also report total plot errors where area is relevant. Evaluate negative/zero changes before any issuance floor. Avoid MAPE when observations approach zero. Report subgroup counts/errors for context, soil, irrigation, season and plot size, without implying reliability for tiny subgroups.

Use uncertainty methods that retain site/block/treatment pairing and repeated-measure dependence. Cluster bootstrap or a reviewed hierarchical model are candidates; individual image pixels and repeated observations are not independent plot replicates. Published standard errors, LSDs, standard deviations and confidence intervals are not interchangeable. Unknown covariance does not justify an invented precision interval.

Before holdout access, freeze acceptable bias/error, interval coverage, subgroup minimum support, yield margin, abstention limits and practical improvement thresholds with the specialist. Record thresholds, rationale and sign-off; until then classify results as exploratory. Confidence-quality score, predictive uncertainty, classification probability and permanence buffer remain separate variables.

## 8. Review, eligibility and promotion

Review packet: selected contexts/practices and baseline; source-factor audit; soil/gas sampling protocol; net-GHG boundary; uncertainty/power analysis; split manifest and metrics; additionality/permanence/leakage questions; all limitations. Seek an actual soil-carbon/agronomy reviewer, and a rice-GHG specialist for the water/gas track. Potential institutions are data/reviewer leads, not endorsers; no one has been contacted.

The [specialist review brief](specialist-review-brief.md) provides the questions and sign-off fields, including thresholds to complete before holdout evaluation.

Additionality records must assess prior adoption, counterfactual management, applicable obligations and incentive/project history under the chosen current methodology. Buffer percentages cannot repair systematic bias or missing emissions. Imported amendments need origin and boundary review. Scientific measurement success does not confer market recognition.

Promotion gates: literature lead → usable licensed data → reproducible baseline → frozen independent evaluation → dated specialist review → supported-context release. Scientific estimates stay in the research namespace until methodology approval. Advisory ML release does not authorise automatic issuance, penalties or payouts.

## 9. Executable work now and staged deliverables

The existing [benchmark script](../../scripts/reproduce_mrv_benchmark.py) reproduces published Bihar stock-change arithmetic only. The new [sensitivity script](../../scripts/analyse_mrv_sensitivity.py) evaluates the structure of the placeholder NDVI formula on explicitly synthetic cases; its [output](mrv-sensitivity-results.json) is not field validation.

Within the demo's 4–8 week window: finish source/data audit; choose the first West Bengal context based on actual evidence access; obtain reviewed thresholds/sampling plan; freeze baseline code and manifests; reproduce accessible published tables. If independent historical data are obtained, evaluate them with declared splits. Otherwise deliver the protocol, source audit, executable structural checks and a clearly labelled demonstration of the pipeline, without an accuracy claim.

A new field SOC experiment is a separate, potentially multi-year programme. The first season can establish baseline, evidence quality and gas measurements under a funded protocol, but is not promised to establish durable SOC removal. Record all results—including failure or insufficient evidence—in a reproducible report.

Current blockers: exact partner/site selection, licensed raw replicate/management records, paired satellite inputs, sampling budget/lab capacity, named domain reviewer and pre-agreed release thresholds. These do not prevent desk research or demo development; they prevent declaring scientific validation complete.
