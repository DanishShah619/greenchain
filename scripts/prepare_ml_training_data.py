"""Create scoped, identifier-free candidate datasets; does not train a model."""
from pathlib import Path
import hashlib
import json
import re
import sys
import warnings
import importlib.metadata

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".research-deps"))
import pandas as pd
import pyreadr

BASE = ROOT / "data/ml"
OUT = BASE / "prepared"
SURVEY_FIELDS = [
    "state", "district", "crop", "season", "year", "soilTexture", "drainClass",
    "soilPerception", "prevCrop", "prevCropTillage", "prevCropHarvest",
    "cropResiduePcnt", "residueBurnt", "residueBurnt.1", "varType", "varName",
    "LandPrep", "CropEst", "FYM", "typeFYM", "amtFYM", "applyMineralFert",
    "irrigAvail", "irrigSource", "irrigTimes", "pumpEnergy", "seed_ha",
    "total_N_ha", "total_p_ha", "total_K_ha", "Tmax_avg", "Tmin_avg",
    "Rain_avg", "rad_avg", "cropLarestAreaAcre", "L.tonPerHectare", "cropCutDone",
]
STUDIES = {
    134: {"doi": "10.1016/j.ecoinf.2023.102013", "district": "Purulia",
          "source_url": "https://www.sciencedirect.com/science/article/pii/S1574954123000420"},
    146: {"doi": "10.1016/j.spc.2022.09.001", "district": "Burdwan",
          "source_url": "https://www.sciencedirect.com/science/article/pii/S235255092200241X"},
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def summary(df):
    return {"rows": len(df), "columns": len(df.columns),
            "missing_per_column": {k: int(v) for k, v in df.isna().sum().items()},
            "column_names": list(df.columns)}


def write_table(df, name):
    path = OUT / name
    df.to_csv(path, index=False, lineterminator="\n")
    return {"path": str(path.relative_to(ROOT)).replace("\\", "/"),
            "sha256": digest(path), **summary(df)}


def prepare_survey():
    source = BASE / "raw/nayak_2024/all_year_data.RData"
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        objects = pyreadr.read_r(str(source))
    if "data" not in objects or "state" not in objects["data"]:
        raise ValueError("Expected 2018 survey schema absent")
    raw = objects["data"]
    mask = raw.state.astype(str).str.replace(" ", "").str.casefold().eq("westbengal")
    positions = [i for i, selected in enumerate(mask) if selected]
    selected = raw.loc[mask]
    absent = [x for x in SURVEY_FIELDS if x not in selected.columns]
    if absent:
        raise ValueError(f"Expected survey fields absent: {absent}")
    frame = selected[SURVEY_FIELDS].copy().reset_index(drop=True)
    # The allowlist excludes direct identifiers, exact coordinates, village and device records.
    frame = frame.replace(r"^\s*$", pd.NA, regex=True)
    frame.insert(0, "record_id", [f"nayak2024_data_row_{i:05d}" for i in positions])
    frame["state"] = "West Bengal"
    frame["label_origin"] = "FARMER_REPORTED_SURVEY"
    frame["practice_independently_verified"] = False
    frame["yield_label_origin"] = "SELF_REPORTED_NOT_CROP_CUT"
    frame["unit_audit_status"] = "SOURCE_FIELDS_PRESERVED_CODEBOOK_REVIEW_REQUIRED"
    frame["split_group_id"] = "wb_district:" + frame.district.astype(str)
    frame["yield_t_ha"] = pd.to_numeric(frame["L.tonPerHectare"], errors="coerce")
    frame["yield_nonpositive_or_missing"] = frame.yield_t_ha.isna() | frame.yield_t_ha.le(0)
    frame["yield_outside_exploratory_range"] = frame.yield_t_ha.lt(0.5) | frame.yield_t_ha.gt(10)
    frame["feature_target_duplicate_candidate"] = frame.duplicated(subset=SURVEY_FIELDS, keep=False)
    forbidden = re.compile(r"name$|aadhar|aadhaar|mobile|phone|gps|latitude|longitude|device|instance", re.I)
    # varName is a crop variety, not a personal name; all other name fields stay excluded.
    assert not any(forbidden.search(c) for c in frame.columns if c != "varName")
    assert selected.cropCutDone.astype(str).str.lower().eq("no").all()
    result = write_table(frame, "west_bengal_rice_management_2018.csv")
    result.update({
        "source_object": "data", "source_RData_sha256": digest(source),
        "district_counts": frame.district.value_counts().to_dict(),
        "years": sorted(frame.year.astype(str).unique().tolist()),
        "readiness": "CURATED_EXPLORATORY_MANAGEMENT_AND_YIELD_NOT_VERIFIED_PRACTICE_LABELS",
        "paper_reported_WB_analysis_rows": 1363,
        "source_WB_rows": len(frame),
        "paper_subset_discrepancy": "Retain 1382 source rows; paper reports 1363 analysed. Do not invent the authors' exclusions.",
        "loader_warning_count": len(caught),
        "loader_warning_note": "R-date conversion warning; date fields excluded from candidate export",
        "privacy": "Allowlisted agricultural fields only; no farmer name, phone, Aadhaar, device, exact coordinates or village",
        "no_train_test_split_claim": "District group proposed; split not frozen; tiny district samples and repeated-farm identity need review",
        "numeric_yield_quality": {
            "nonpositive_or_missing": int(frame.yield_nonpositive_or_missing.sum()),
            "outside_exploratory_range": int(frame.yield_outside_exploratory_range.sum()),
            "duplicate_candidate_rows": int(frame.feature_target_duplicate_candidate.sum()),
        },
    })
    return result


def prepare_emissions():
    source = BASE / "raw/thai_2026/data_Full.csv"
    frame = pd.read_csv(source)
    assert {"StudyID", "Site", "CH4", "N2O", "GY", "WaR"}.issubset(frame.columns)
    source_columns = list(frame.columns)
    frame.insert(0, "source_record_id", [f"thai2026_csv_row_{i:05d}" for i in range(len(frame))])
    frame["exact_source_duplicate_candidate"] = frame.duplicated(subset=source_columns, keep=False)
    india = frame.loc[frame.Site.eq("India")].copy()
    wb = india.loc[india.StudyID.isin(STUDIES)].copy()
    wb["verified_state"] = "West Bengal"
    wb["verified_district"] = wb.StudyID.map({k: v["district"] for k, v in STUDIES.items()})
    wb["original_study_doi"] = wb.StudyID.map({k: v["doi"] for k, v in STUDIES.items()})
    wb["label_origin"] = "META_ANALYSIS_EXTRACTED_STUDY_OUTCOMES_NOT_RAW_REPLICATES"
    wb["precision_audit_status"] = "SD_SE_REPLICATION_AND_DIGITISATION_REQUIRE_ORIGINAL_STUDY_CHECK"
    wb["leakage_group"] = "related_gangopadhyay_wb_2018_2020"
    reports = {
        "global": write_table(frame, "global_rice_emissions_meta_analysis.csv"),
        "india": write_table(india, "india_rice_emissions_meta_analysis.csv"),
        "west_bengal": write_table(wb, "west_bengal_rice_emissions_study_extracts.csv"),
    }
    for name, df in [("global", frame), ("india", india), ("west_bengal", wb)]:
        reports[name]["study_count"] = int(df.StudyID.nunique())
        reports[name]["rows_per_study"] = {str(k): int(v) for k, v in df.StudyID.value_counts().items()}
        reports[name]["target_missing_counts"] = {c: int(df[c].isna().sum()) for c in ["CH4", "N2O", "GY"]}
        reports[name]["readiness"] = "CANDIDATE_GAS_OUTCOME_RESEARCH_PENDING_TARGET_UNITS_AND_PRECISION_AUDIT"
        reports[name]["exact_source_duplicate_candidate_rows"] = int(df.exact_source_duplicate_candidate.sum())
        reports[name]["reused_ES_ID_within_study"] = int(df.duplicated(subset=["StudyID", "ES_ID"]).sum())
    assert len(wb) == 108 and wb.StudyID.nunique() == 2
    reports["west_bengal"]["location_evidence"] = STUDIES
    reports["west_bengal"]["no_independent_holdout_claim"] = "Two related study sources; not 108 independent plots; possible shared trials need reconciliation"
    reports["west_bengal"]["not_SOC_target"] = True
    difference = (wb.GWP - (27.9 * wb.CH4 + 273 * wb.N2O)).abs()
    reports["west_bengal"]["source_GWP_formula_max_abs_difference"] = float(difference.max())
    return reports


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {
        "prepared_date": "2026-10-13",
        "survey": prepare_survey(),
        "emissions": prepare_emissions(),
        "environment": {x: importlib.metadata.version(x) for x in ["pandas", "numpy", "pyreadr", "narwhals"]},
        "model_training_performed": False,
        "carbon_credit_issuance_permitted": False,
    }
    (BASE / "data_quality_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"survey_rows": report["survey"]["rows"],
                      "emissions_rows": {k: v["rows"] for k, v in report["emissions"].items()},
                      "survey_district_counts": report["survey"]["district_counts"],
                      "survey_yield_missing": report["survey"]["missing_per_column"]["yield_t_ha"],
                      "status": "curated_candidate_data_not_model_validation"}, indent=2))


if __name__ == "__main__":
    prepare()
