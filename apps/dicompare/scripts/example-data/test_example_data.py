"""Check the bundled example session gives the reports the app advertises.

Runs the same dicompare calls the web worker makes (analyze_dicom_files_for_ui,
then validate_acquisition_direct) against the bundled zip and library schemas,
using the dicompare version pinned in src/version.ts. Run with:

    pip install "dicompare==<pinned>" pytest
    pytest scripts/example-data
"""

import asyncio
import json
import zipfile
from collections import Counter
from pathlib import Path

import pytest
from dicompare.interface import analyze_dicom_files_for_ui, validate_acquisition_direct

REPO_ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_ZIP = REPO_ROOT / "public" / "example-data" / "dicompare-example-session.zip"
SCHEMAS = REPO_ROOT / "public" / "schemas"


@pytest.fixture(scope="module")
def acquisitions():
    with zipfile.ZipFile(EXAMPLE_ZIP) as zf:
        files = {n: zf.read(n) for n in zf.namelist() if n.endswith(".dcm")}
    acqs = asyncio.run(analyze_dicom_files_for_ui(files, None))
    return {a["protocolName"]: a for a in acqs}


def validate(acquisition, schema_file, acquisition_name):
    schema_text = (SCHEMAS / schema_file).read_text()
    names = list(json.loads(schema_text)["acquisitions"])
    return validate_acquisition_direct(acquisition, schema_text, names.index(acquisition_name))


def test_bundle_is_small():
    assert EXAMPLE_ZIP.stat().st_size < 1_000_000


def test_session_has_two_acquisitions(acquisitions):
    assert set(acquisitions) == {"acq-t1wmpr", "acq-qsmmegre"}
    assert acquisitions["acq-t1wmpr"]["totalFiles"] == 3
    # 5 echoes x (magnitude, phase) x 4 slices
    assert acquisitions["acq-qsmmegre"]["totalFiles"] == 40


def test_t1w_passes_hcp(acquisitions):
    results = validate(acquisitions["acq-t1wmpr"], "hcp_schema.json", "T1-weighted 3D MPRAGE")
    assert results, "no checks ran"
    failing = [r for r in results if r["status"] != "pass"]
    assert failing == []


def test_qsm_report_matches_figure(acquisitions):
    results = validate(
        acquisitions["acq-qsmmegre"],
        "QSM_Consensus_Guidelines_v1.0.json",
        "Quantitative Susceptibility Mapping (QSM)",
    )
    assert Counter(r["status"] for r in results) == {"pass": 8, "fail": 2, "warning": 1}

    by_status = {s: [r["message"] for r in results if r["status"] == s] for s in ("fail", "warning")}
    assert any("spacing not uniform" in m and "[7.5, 7.5, 6.0, 7.5]" in m for m in by_status["fail"])
    assert any("220 Hz/pixel" in m and "300" in m for m in by_status["fail"])
    assert any("First TE could be shorter (6.0 ms)" in m for m in by_status["warning"])
