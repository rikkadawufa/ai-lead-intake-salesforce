"""Paths and helpers shared by the fixture, reset and results scripts."""
import json
import re
from pathlib import Path

try:
    from .envfile import ROOT
except ImportError:
    from envfile import ROOT

FIXTURES_PATH = ROOT / "sample-data" / "fixtures.json"
OUTPUT = ROOT / "output"
RUN_LOG_DIR = OUTPUT / "run-log"
REVIEW_DIR = OUTPUT / "review"
FORM_URL = "http://localhost:5680/webhook/inquiry"


def load_fixtures(path=FIXTURES_PATH):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data["fixtures"], data.get("reviews", [])


def load_seed(path=FIXTURES_PATH):
    """Existing customers created by salesforce_setup.py before the run (T9 writes in as one of them)."""
    return json.loads(Path(path).read_text(encoding="utf-8")).get("seed_contacts", [])


def by_id(fixtures):
    return {fixture["id"]: fixture for fixture in fixtures}


def base_fixture(fixture, fixtures):
    return by_id(fixtures)[fixture["resend_of"]] if fixture.get("resend_of") else fixture


def source_id(fixture, fixtures):
    base = base_fixture(fixture, fixtures)
    return f"form:{base['submission_id']}" if base["channel"] == "form" else f"email:{base['message_id']}"


def safe_id(value):
    """Same rule as safeId() in n8n-src/code/review.js."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "unknown")).strip("_")[:80]


def read_json_files(folder, pattern="*.json"):
    folder = Path(folder)
    if not folder.exists():
        return []
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(folder.glob(pattern))]
