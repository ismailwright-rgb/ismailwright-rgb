from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SAMPLE_DOCS_DIR = PROJECT_ROOT / "sample_cases" / "maria_delgado" / "documents"


@pytest.fixture(scope="session", autouse=True)
def sample_case_fixtures():
    """Ensure the fictional Maria Delgado fixture PDFs exist before any test
    that needs them runs — generates them once per test session if missing,
    rather than requiring a manual step before `pytest` works."""
    medical = SAMPLE_DOCS_DIR / "medical_record_dr_chen.pdf"
    scanned = SAMPLE_DOCS_DIR / "er_intake_scanned.pdf"
    if not medical.exists() or not scanned.exists():
        subprocess.run(
            [sys.executable, str(PROJECT_ROOT / "scripts" / "generate_sample_case.py")],
            check=True,
            cwd=PROJECT_ROOT,
        )
    return {"medical_record": medical, "er_intake_scanned": scanned}


@pytest.fixture
def tmp_data_root(tmp_path: Path) -> Path:
    return tmp_path / "data"
