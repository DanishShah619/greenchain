"""Structural analysis of an experimental formula, using synthetic inputs only."""
from decimal import Decimal, getcontext
from pathlib import Path
import json

getcontext().prec = 28
D = Decimal
AREA = D("1.25")
PRACTICE_FACTOR = D("1.20")  # placeholder tCO2e/ha/cycle, not a sourced factor
DELTA_REF = D("0.20")
CASES = [
    ("greenness_increase", D("0.62"), D("0.50")),
    ("unchanged_greenness", D("0.50"), D("0.50")),
    ("greenness_decrease", D("0.40"), D("0.50")),
]


def evaluate_cases():
    baseline = AREA * PRACTICE_FACTOR
    rows = []
    for name, project, historical in CASES:
        multiplier = max(D(0), min(D(1), (project - historical) / DELTA_REF))
        rows.append({
            "case": name,
            "ndvi_project": str(project),
            "ndvi_baseline": str(historical),
            "multiplier": str(multiplier),
            "practice_only_tCO2e_per_cycle": str(baseline),
            "experimental_formula_tCO2e_per_cycle": str(baseline * multiplier),
            "measured_SOC_change": None,
        })
    assert rows[0]["experimental_formula_tCO2e_per_cycle"] == "0.90000"
    assert D(rows[1]["experimental_formula_tCO2e_per_cycle"]) == 0
    assert D(rows[2]["experimental_formula_tCO2e_per_cycle"]) == 0
    return {
        "status": "synthetic_structural_analysis_not_prediction_validation",
        "area_ha": str(AREA),
        "placeholder_factor_tCO2e_per_ha_per_cycle": str(PRACTICE_FACTOR),
        "placeholder_delta_ref": str(DELTA_REF),
        "cases": rows,
        "findings": [
            "Identical area/practice inputs give different amounts solely through greenness.",
            "Unchanged/decreased greenness forces zero; correctness requires independent observations.",
            "The practice-only comparator is experimental too, not a measured carbon benefit.",
            "No field measurements, uncertainty calibration or prediction accuracy are claimed.",
        ],
    }


if __name__ == "__main__":
    result = evaluate_cases()
    output = Path(__file__).resolve().parents[1] / "docs/research/mrv-sensitivity-results.json"
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
