# GreenChain MRV evidence review

Date: 2026-10-11. Status: desk review and published-result reproduction only. No expert endorsement or independent prediction-validation claim. No production factors changed.

The literature supports investigating practice-based carbon estimation. It does not establish the validity of GreenChain's proposed `area × sum_of_factors × NDVI_multiplier`. The pilot crop, soil, region and practice have not been selected. Bihar rice–wheat is used below solely as a reproducible research example.

2026-10-12 scope update: the project owner selected West Bengal crops and farming practices. The [local research protocol](west-bengal-research-protocol.md) and [evidence catalogue](west-bengal-evidence-catalogue.md) now guide site/practice selection. The Bihar calculation remains an external arithmetic example, not a local calibration or independent validation dataset.

## Review of the supplied conversation

The [shared conversation](https://chatgpt.com/share/6a8c06cb-b4d0-83ee-addd-d6785b9044bb) contains suggested references, not a field dataset or a completed validation.

- Paustian et al. (2019), [Soil C Sequestration as a Biological Negative Emission Strategy](https://www.frontiersin.org/journals/climate/articles/10.3389/fclim.2019.00008/full), is in **Frontiers in Climate**, not Nature Communications. It is a review, useful for scientific context.
- Exact-title searches did not verify “A Remote Sensing Approach for Monitoring Agricultural Carbon Projects” attributed to Chagas (2021), or “Digital MRV for Carbon Markets” attributed to Sánchez (2022). Treat these citations as unverified until an original publication or DOI is supplied. This is not proof that no related work exists.
- Fairness and reputation references may support the allocation research but do not supply agricultural emission factors.

## Published benchmark

[Sapkota et al. (2017), DOI 10.1111/sum.12331](https://repository.cimmyt.org/server/api/core/bitstreams/b96af35e-0227-4cce-9c40-32828befd542/content), Table 4: Samastipur, Bihar; rice–wheat; calcareous soil; 2006–2013; 0–0.6 m depth. Zero tillage in both crops plus residue retention gained 4.66 t C/ha; conventional management lost 0.90. Derived annual rates are 2.441 t CO2/ha absolute gain and 2.912 relative to control. These are bundled-treatment, seven-year averages, not per-crop factors. Table 4's 2.49 t C/ha minimum significant difference is not a factor confidence interval. Raw replicate/covariance data are needed for propagation of uncertainty. Sampling used multiple depths and bulk density. Do not transfer these results directly to West Bengal or add them to separate tillage/residue factors.

## Other evidence and applicability

[Cariappa et al. (2024), DOI 10.1038/s41598-024-59262-6](https://www.nature.com/articles/s41598-024-59262-6), analyses conservation agriculture using surveys and remote sensing in Bihar and Punjab. Reported mitigation potentials of 1.23 and 1.97 t CO2e/ha concern wheat-season practice packages, not isolated SOC removals. Its additionality analysis is relevant; it is not a validation of GreenChain's NDVI multiplier. Selected district data are supplementary; other datasets require an author request. Historical eligibility findings must be checked against the methodology version used by the project.

[Organic amendments influence soil quality and carbon sequestration in the Indo-Gangetic plains of India (2012)](https://doi.org/10.1016/j.agee.2012.05.009) concerns a 25-year West Bengal rice–wheat experiment. The accessible publisher material reports input-carbon retention fractions, not a ready per-cycle CO2 factor. Full tables and treatment baselines need review before parameterisation.

## Reproduction

Run `python scripts/reproduce_mrv_benchmark.py`. It uses decimal arithmetic and explicit units, with values transcribed from the published table. The printed output is also saved beside this note.

`absolute annual rate = treatment stock change / years × 44/12`

`control-relative annual rate = (treatment change − control change) / years × 44/12`

The two estimates answer different questions. Agreement between two arithmetic routes checks calculation consistency only. It does not reproduce the laboratory measurements or validate a predictive model. A treatment–control difference alone does not prove crediting additionality.

## Implications for the proposed formula

These are analytical findings from comparing the project design with the evidence, not expert sign-off:

1. Store factor time basis explicitly: annual rotation, crop cycle or monitoring interval. Never apply an annual rotation result twice for rice and wheat.
2. Preserve treatment bundles and baseline definitions. Adding independently published practice effects can double-count interacting benefits.
3. Separate SOC removals from avoided methane, nitrous oxide and fuel emissions; define the net-GHG boundary before claiming credit quantities.
4. The clamp on NDVI uplift forces zero estimated carbon when greenness does not rise. That is a modelling assumption requiring paired observations, not an established conclusion from these papers.
5. Confidence scores and buffer percentages are policy/model parameters. They do not substitute for estimation uncertainty or scientific calibration.

## Validation status and next evidence

| Requested step | Result | Outstanding evidence |
|---|---|---|
| Source factors and context | Candidate benchmark identified | Selected pilot conditions; defensible uncertainty; transfer assessment |
| Specialist review | Not performed | Actual reviewer, dated comments on baseline, additionality and sampling |
| Independent worked calculation | Arithmetic reproduced | Raw laboratory/replicate reproduction is separate |
| Compare GreenChain predictions with independent observations | Not performed | Paired inputs and measured SOC changes; frozen parameters; expert-agreed error limits |

For prediction validation, obtain treatment/control plot boundaries, management history, starting/final SOC, bulk density, depth, dates and replicate uncertainty; add independently processed satellite histories for the same plots and period. A concentration-only spatial dataset cannot directly validate changes in carbon stock over time.

Freeze the model and factor versions before evaluating a holdout dataset from a separate site or experiment. Report signed bias, MAE, RMSE and uncertainty coverage in t CO2e/ha/year, stratified by crop, soil and region. Include controls and compare with a practice-only baseline to assess the NDVI multiplier's contribution. Do not set a pass threshold after seeing errors; no universal threshold is asserted here.

An expert review request should ask whether the treatment and baseline match the pilot, whether fixed-depth stocks need equivalent-soil-mass adjustment, whether the GHG boundary is complete, whether NDVI scaling is scientifically justified, and what sampling and error criteria support the intended claim. No author or specialist has been contacted.
