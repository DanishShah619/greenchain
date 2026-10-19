"""Reproduce published SOC arithmetic; not a carbon-credit issuance model."""
from decimal import Decimal, getcontext
from pathlib import Path
import json

getcontext().prec = 28
D = Decimal
# Sapkota et al. 2017, Table 4, full 0–0.6 m profile, 2006–2013.
SOURCE = "https://doi.org/10.1111/sum.12331"
treatment_delta = D("4.66")  # t C/ha over seven years
control_delta = D("-0.90")   # t C/ha over seven years
years = D("7")
co2_per_c = D(44) / D(12)
area = D("1.25")  # hypothetical area, not a sampled plot

absolute = treatment_delta / years * co2_per_c
relative = (treatment_delta - control_delta) / years * co2_per_c
alternate = (treatment_delta * co2_per_c - control_delta * co2_per_c) / years
assert abs(relative - alternate) < D("1e-24")

def rounded(value):
    return str(value.quantize(D("0.000001")))

result = {
    "status": "published_table_arithmetic_only_not_prediction_validation",
    "source_doi": SOURCE,
    "inputs": {
        "treatment_delta_t_C_per_ha_over_7_years": str(treatment_delta),
        "control_delta_t_C_per_ha_over_7_years": str(control_delta),
        "years": str(years),
        "hypothetical_area_ha": str(area),
    },
    "derived": {
        "absolute_t_CO2_per_ha_per_year": rounded(absolute),
        "control_relative_t_CO2_per_ha_per_year": rounded(relative),
        "absolute_t_CO2_per_year_for_hypothetical_area": rounded(absolute * area),
        "control_relative_t_CO2_per_year_for_hypothetical_area": rounded(relative * area),
    },
    "checks": {"two_arithmetic_routes_agree": True},
    "uncertainty_interval": None,
    "prediction_error_metrics": None,
    "limitations": [
        "Annualised seven-year averages, not per-crop factors or guaranteed annual rates.",
        "SOC-related CO2 conversion only; not a complete net-GHG credit calculation.",
        "No paired NDVI inputs, expert-agreed error threshold or independent holdout evaluation.",
        "Do not use these outputs as approved production factors.",
    ],
}
output = Path(__file__).resolve().parents[1] / "docs/research/mrv-benchmark-results.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, indent=2))
