"""Put the HubSpot run and this Salesforce run side by side for the same T1–T8 scenarios.

  python scripts/compare_results.py                      # reads output/results.json
  python scripts/compare_results.py --salesforce results/salesforce-live-round-1.json
Writes output/results-side-by-side.md. Pass/fail comes from each run's own checking script.
"""
import argparse
import json
from pathlib import Path

try:
    from .demo_common import OUTPUT, ROOT
except ImportError:
    from demo_common import OUTPUT, ROOT

HUBSPOT = ROOT / "results" / "hubspot-live-round-2.json"


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def compare(hubspot, salesforce):
    hub_rows = {item["id"]: item for item in hubspot["rows"]}
    sf_rows = {item["id"]: item for item in salesforce["rows"]}
    result = lambda item: "not run" if item is None else ("PASS" if item["pass"] else "FAIL")
    lines = []
    for fixture_id in [*hub_rows, *[key for key in sf_rows if key not in hub_rows]]:
        hub, sf = hub_rows.get(fixture_id), sf_rows.get(fixture_id)
        title = (sf or hub)["title"]
        hub_cell = result(hub) if hub else "not in the HubSpot run"
        lines.append(f"| {fixture_id} | {title} | {hub_cell} | {result(sf)} |")
    core = lambda run: f"{run['summary']['passed']} / {run['summary']['total']}"
    return lines, core(hubspot), core(salesforce)


def render(hubspot, salesforce, salesforce_label):
    lines, hub_score, sf_score = compare(hubspot, salesforce)
    source = hubspot.get("source", {})
    return "\n".join([
        "# Same scenarios, two CRMs",
        "",
        "Same made-up inquiries, prompts, OpenAI model and review steps. Only the CRM step differs.",
        "",
        f"| # | Scenario | HubSpot ({source.get('run', 'reference run')}, {source.get('generated', '')[:10]}) | Salesforce ({salesforce_label}) |",
        "|---|---|---|---|",
        *lines,
        "",
        f"T1–T8: HubSpot {hub_score}, Salesforce {sf_score}.",
        "",
        "Each column is scored by its own project's `collect_results.py` against HubSpot or Salesforce and the demo inbox.",
        "T9 needs a record type HubSpot doesn't have (an existing Contact next to Leads), so it only runs here.",
    ]) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--salesforce", default=str(OUTPUT / "results.json"))
    parser.add_argument("--label", help="column label for the Salesforce run (default: its generated date)")
    args = parser.parse_args()
    salesforce = load(args.salesforce)
    label = args.label or f"run of {salesforce.get('generated', 'unknown date')[:10]}"
    text = render(load(HUBSPOT), salesforce, label)
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / "results-side-by-side.md").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
