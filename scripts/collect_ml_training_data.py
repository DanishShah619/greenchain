"""Download public research data with provenance; never executes downloaded code."""
from pathlib import Path
import hashlib
import json
import ssl
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "data/ml"
ARTICLE = "https://www.nature.com/articles/s41467-024-52448-6"
URL = ("https://media.springernature.com/original/springer-static/esm/"
       "art%3A10.1038%2Fs41467-024-52448-6/MediaObjects/"
       "41467_2024_52448_MOESM4_ESM.zip")
MAX_BYTES = 120 * 1024 * 1024
EXPECTED_SURVEY_SHA256 = "22152e70566143a196c26660af445c7f4c0a3b342045baaa277d96ee94db63af"


def collect():
    folder = BASE / "raw/nayak_2024"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "supplementary_data_1_2.zip"
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_default_certs()
    if not target.exists():
        request = urllib.request.Request(URL, headers={"User-Agent": "GreenChain-Research/0.1"})
        size = 0
        temporary = target.with_suffix(".zip.part")
        with urllib.request.urlopen(request, context=context, timeout=45) as response:
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > MAX_BYTES:
                raise ValueError("Source exceeds configured download budget")
            with temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError("Source exceeds configured download budget")
                    output.write(chunk)
        if not zipfile.is_zipfile(temporary):
            raise ValueError("Response was not a ZIP archive")
        temporary.replace(target)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if digest != EXPECTED_SURVEY_SHA256:
        raise ValueError("Survey content changed; review provenance before preparing a new version")
    with zipfile.ZipFile(target) as archive:
        members = [{"name": x.filename, "bytes": x.file_size} for x in archive.infolist()]
    record = {
        "dataset_id": "nayak_2024_rice_management",
        "title": "Context-dependent agricultural intensification pathways to increase rice production in India",
        "source_doi": "10.1038/s41467-024-52448-6",
        "source_url": ARTICLE,
        "download_url": URL,
        "retrieved_date": "2026-10-13",
        "licence": "CC BY 4.0; inspect supplementary notices before derived release",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "local_path": str(target.relative_to(ROOT)).replace("\\", "/"),
        "sha256": digest,
        "bytes": target.stat().st_size,
        "archive_members": members,
        "origin": "PUBLISHED_FIELD_SURVEY_AND_DERIVED_DATA",
        "readiness": "DOWNLOADED_PENDING_SCHEMA_AND_LABEL_AUDIT",
        "not_carbon_ground_truth": True,
    }
    (folder / "source_manifest.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(record, indent=2))


def collect_emissions():
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_default_certs()
    metadata_url = "https://api.figshare.com/v2/articles/29817482"
    with urllib.request.urlopen(metadata_url, context=context, timeout=45) as response:
        metadata = json.load(response)
    if metadata.get("license", {}).get("name") != "CC BY 4.0":
        raise ValueError("Emissions source licence changed; review before collection")
    files = [x for x in metadata["files"] if x["id"] == 56877194 and x["name"] == "data_Full.csv"]
    if len(files) != 1:
        raise ValueError("Expected versioned emissions file not found")
    source = files[0]
    if source["size"] > 10 * 1024 * 1024:
        raise ValueError("Emissions source exceeds configured download budget")
    folder = BASE / "raw/thai_2026"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "repository_metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    target = folder / source["name"]
    if not target.exists():
        with urllib.request.urlopen(source["download_url"], context=context, timeout=45) as response:
            content = response.read(10 * 1024 * 1024 + 1)
        if len(content) != source["size"]:
            raise ValueError("Emissions file size does not match repository metadata")
        target.write_bytes(content)
    content = target.read_bytes()
    if hashlib.md5(content).hexdigest() != source["computed_md5"]:
        raise ValueError("Emissions file checksum does not match repository")
    record = {
        "dataset_id": "thai_2026_rice_emissions",
        "source_doi": metadata["doi"],
        "source_url": "https://doi.org/10.6084/m9.figshare.29817482.v1",
        "metadata_url": metadata_url,
        "download_url": source["download_url"],
        "retrieved_date": "2026-10-13",
        "licence": metadata["license"],
        "local_path": str(target.relative_to(ROOT)).replace("\\", "/"),
        "sha256": hashlib.sha256(content).hexdigest(),
        "md5_repository_verified": source["computed_md5"],
        "bytes": len(content),
        "origin": "PUBLISHED_STUDY_EXTRACTED_EXPERIMENTS",
        "readiness": "DOWNLOADED_PENDING_SCHEMA_AND_LOCAL_APPLICABILITY_AUDIT",
        "not_SOC_change_ground_truth": True,
    }
    (folder / "source_manifest.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(record, indent=2))


def purge_identifier_bearing_survey_sources():
    """Remove only this collector's explicitly named temporary source files."""
    folder = (BASE / "raw/nayak_2024").resolve()
    names = ["supplementary_data_1_2.zip", "supplementary_data_1_2.zip.part",
             "all_year_data.RData", "Data_for_script_3.RData"]
    removed = []
    for name in names:
        path = (folder / name).resolve()
        if path.parent != folder or not path.is_relative_to(ROOT.resolve()):
            raise ValueError("Survey cleanup target escaped the workspace")
        if path.exists():
            path.unlink()
            removed.append(name)
    manifest = folder / "source_manifest.json"
    if manifest.exists():
        record = json.loads(manifest.read_text(encoding="utf-8"))
        record["source_archive_retention"] = "REMOVED_AFTER_PRIVACY_AUDIT; original checksum retained"
        record["readiness"] = "SEE data/ml/data_quality_report.json FOR CURATED_EXPORT"
        record["removed_temporary_sources"] = removed
        manifest.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return removed


if __name__ == "__main__":
    try:
        collect()
        collect_emissions()
        import zipfile
        with zipfile.ZipFile(BASE / "raw/nayak_2024/supplementary_data_1_2.zip") as archive:
            # Never extract arbitrary archive paths or load the supplied model/SHAP object.
            (BASE / "raw/nayak_2024/all_year_data.RData").write_bytes(archive.read("Data/all_year_data.RData"))
        from prepare_ml_training_data import prepare
        prepare()
    finally:
        purge_identifier_bearing_survey_sources()
