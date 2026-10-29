"""Check T1–T9 against the run logs, Salesforce and the demo inbox, then write output/results.md.

T1–T8 are the same scenarios as the HubSpot version; T9 (an existing Contact writes in) is reported separately.
Every number in the results comes from this script, not from the AI.
  python scripts/collect_results.py            # evaluate the latest initial batch and reviews
  python scripts/collect_results.py --replay   # evaluate the latest replay batch (idempotency)
"""
import argparse
import email
import imaplib
import json
from datetime import datetime
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from pathlib import Path

try:
    from .demo_common import OUTPUT, RUN_LOG_DIR, by_id, load_fixtures, load_seed, read_json_files, source_id
    from .envfile import load_env, require
    from .salesforce_setup import client_from_env
except ImportError:
    from demo_common import OUTPUT, RUN_LOG_DIR, by_id, load_fixtures, load_seed, read_json_files, source_id
    from envfile import load_env, require
    from salesforce_setup import client_from_env


def latest_send_log(mode, output=OUTPUT):
    paths = sorted(Path(output).glob(f"send-log-{mode}-*.json"))
    return json.loads(paths[-1].read_text(encoding="utf-8")) if paths else None


def logs_since(logs, started):
    return [log for log in logs if log.get("ts", "") >= started]


def find_log(logs, sid, action=None):
    matches = [log for log in logs if log.get("source_id") == sid and (action is None or log.get("action") == action)]
    return matches[-1] if matches else None


def row(fixture_id, title, checks, extra=False):
    failed = [f"{name}: expected {expected!r}, got {actual!r}" for name, expected, actual in checks if expected != actual]
    shown = "; ".join(f"{name}={actual}" for name, _, actual in checks)
    return {"id": fixture_id, "title": title, "pass": not failed, "observed": shown, "problems": failed, "extra": extra}


def summarize(rows, record_count):
    core = [item for item in rows if not item["extra"]]
    extra = [item for item in rows if item["extra"]]
    return {"passed": sum(item["pass"] for item in core), "total": len(core),
            "extra_passed": sum(item["pass"] for item in extra), "extra_total": len(extra), "demo_records": record_count}


def evaluate(fixtures, reviews, logs, send_log, review_log, people, sent_mail, redirect_to, seed_email="avery.brooks@example.com"):
    fx = by_id(fixtures)
    sid = {fixture["id"]: source_id(fixture, fixtures) for fixture in fixtures}
    sends = {item["id"]: item for item in (send_log or {}).get("results", [])}
    log = lambda fixture_id, action=None: find_log(logs, sid[fixture_id], action) or {}
    first = {k: log(k, "created") or log(k, "updated") for k in ("T1", "T2", "T4", "T5", "T7", "T9") if k in sid}
    record = lambda address, kind=None: next((item for item in people if (item.get("email") or "").lower() == address and (kind is None or item["type"] == kind)), {})
    dana = record(fx["T1"]["payload"]["email"])
    t1_review = next((item for item in (review_log or {}).get("results", []) if item.get("fixture") == "T1"), {})
    demo_mail = [item for item in sent_mail if item["to"] == redirect_to]
    t1_edit = next((item.get("edit_body") for item in reviews if item["fixture"] == "T1"), "")
    edited_line = next((line for line in t1_edit.split("\n") if len(line) > 60), None)
    edited_mail = [item for item in demo_mail if edited_line and edited_line in item["body"]]
    same_as_t1 = lambda entry: bool(first["T1"].get("record_id")) and entry.get("record_id") == first["T1"].get("record_id")
    rows = [
        row("T1", fx["T1"]["title"], [
            ("action", "created", first["T1"].get("action")), ("record", "Lead", first["T1"].get("record_type")),
            ("tier", "qualified", first["T1"].get("tier")), ("draft", "approved", first["T1"].get("draft")), ("edited", True, first["T1"].get("edited")),
        ]),
        row("T2", fx["T2"]["title"], [
            ("action", "updated", first["T2"].get("action")), ("same record as T1", True, same_as_t1(first["T2"])),
            ("inquiry tasks on the Lead", 2, dana.get("inquiry_tasks")), ("final tier", "qualified", dana.get("lead_tier")),
            ("draft", "approved", first["T2"].get("draft")), ("edited", False, first["T2"].get("edited")),
        ]),
        row("T3", fx["T3"]["title"], [
            ("action", "duplicate_submission", log("T3", "duplicate_submission").get("action")),
            ("same record as T1", True, same_as_t1(log("T3", "duplicate_submission"))),
            ("drafts for this submission", 1, len([item for item in logs if item.get("source_id") == sid["T1"] and item.get("draft") != "none"])),
        ]),
        row("T4", fx["T4"]["title"], [
            ("action", "created", first["T4"].get("action")), ("tier", "not_qualified", first["T4"].get("tier")), ("draft", "none", first["T4"].get("draft")),
        ]),
        row("T5", fx["T5"]["title"], [
            ("action", "created", first["T5"].get("action")), ("tier", "needs_review", first["T5"].get("tier")),
            ("draft", "rejected", first["T5"].get("draft")), ("sent", None, first["T5"].get("sent_to")),
        ]),
        row("T6", fx["T6"]["title"], [
            ("HTTP status", 400, sends.get("T6", {}).get("http_status")),
            ("Slack alert", 1, len(log("T6", "rejected_input").get("alerts", []))),
            ("Salesforce record", None, log("T6", "rejected_input").get("record_id")),
        ]),
        row("T7", fx["T7"]["title"], [
            ("action", "created", first["T7"].get("action")), ("tier", "needs_review", first["T7"].get("tier")),
            ("llm_ok", False, first["T7"].get("llm_ok")), ("draft", "none", first["T7"].get("draft")), ("Slack alert", 1, len(first["T7"].get("alerts", []))),
        ]),
        row("T8", "Human review: edit + approve, approve, reject", [
            ("incomplete review refused", 422, t1_review.get("incomplete_review_status")),
            ("T1 reply sent to demo inbox", redirect_to, first["T1"].get("sent_to")),
            ("T1 reviewer", "Morgan Lee (Ops)", first["T1"].get("reviewer")),
            ("emails with the edited T1 text", 1, len(edited_mail)),
            ("T5 nothing sent", None, first["T5"].get("sent_to")),
            ("replies in demo inbox", 2, len(demo_mail)),
        ]),
    ]
    if "T9" in fx:
        avery = record(seed_email, "Contact")
        rows.append(row("T9", fx["T9"]["title"], [
            ("action", "updated", first["T9"].get("action")), ("record", "Contact", first["T9"].get("record_type")),
            ("same Contact as before the run", True, bool(avery.get("id")) and first["T9"].get("record_id") == avery.get("id")),
            ("Lead created for this email", False, bool(record(seed_email, "Lead"))),
            ("inquiry tasks on the Contact", 1, avery.get("inquiry_tasks")), ("draft", "rejected", first["T9"].get("draft")),
        ], extra=True))
    return rows, summarize(rows, len(people))


def evaluate_replay(fixtures, logs, replay_log, records_before, records_after):
    sends = {item["id"]: item for item in replay_log.get("results", [])}
    rows = []
    for fixture in fixtures:
        sid = source_id(fixture, fixtures)
        if fixture["id"] == "T6":
            rows.append(row("T6", fixture["title"], [("HTTP status", 400, sends.get("T6", {}).get("http_status"))]))
            continue
        entry = find_log(logs, sid) or {}
        rows.append(row(fixture["id"], fixture["title"], [("action", "duplicate_submission", entry.get("action")), ("new draft", "none", entry.get("draft"))]))
    rows.append(row("ALL", "Leads and Contacts unchanged after replay", [("demo records", records_before, records_after)]))
    return rows, summarize(rows, records_after)


def salesforce_state(client):
    people = client.demo_people()
    tasks = client.tasks_for([item["Id"] for item in people])
    state = []
    for item in people:
        own = [task for task in tasks if task["WhoId"] == item["Id"]]
        state.append({
            "type": item["type"], "id": item["Id"], "email": item.get("Email"), "lead_tier": item.get("Lead_Tier__c"),
            "inquiry_tasks": sum(bool(task.get("Inquiry_Source_ID__c")) for task in own),
            "decision_tasks": sum((task.get("Subject") or "").startswith("AI reply") for task in own),
        })
    return state


def demo_inbox_replies(values, since_iso):
    """Approved replies that landed in the demo inbox (the REPLY_REDIRECT_TO plus-address)."""
    gmail, password = require(values, "GMAIL_ADDRESS"), require(values, "GMAIL_APP_PASSWORD").replace(" ", "")
    started = datetime.fromisoformat(since_iso)
    since = started.strftime("%d-%b-%Y")
    found = []
    imap = imaplib.IMAP4_SSL("imap.gmail.com")
    try:
        imap.login(gmail, password)
        imap.select("INBOX", readonly=True)
        _, data = imap.search(None, "SINCE", since, "SUBJECT", "demo")
        for num in data[0].split():
            _, parts = imap.fetch(num, "(BODY.PEEK[])")
            message = email.message_from_bytes(parts[0][1])
            subject = str(make_header(decode_header(message.get("Subject", ""))))
            # IMAP SINCE only filters by day, so drop replies from earlier runs on the same day.
            if not subject.startswith("[demo") or parsedate_to_datetime(message.get("Date")) < started:
                continue
            body = message.get_payload(decode=True) if not message.is_multipart() else message.get_payload(0).get_payload(decode=True)
            found.append({"to": message.get("To", "").strip().lower(), "subject": subject, "body": (body or b"").decode("utf-8", "replace").replace("\r\n", "\n"), "date": message.get("Date")})
    finally:
        imap.logout()
    return found


def summary_line(summary):
    extra = f" · extra scenarios: {summary['extra_passed']} / {summary['extra_total']}" if summary["extra_total"] else ""
    return f"**{summary['passed']} / {summary['total']} passed**{extra} · demo Leads and Contacts in Salesforce: {summary['demo_records']}"


def write_results(rows, summary, title, stem="results"):
    lines = [f"# {title}", "", f"Generated {datetime.now().isoformat(timespec='seconds')} by `scripts/collect_results.py` (counts come from code, not the AI).", "",
             summary_line(summary), "", "| # | Scenario | Result | Observed |", "|---|---|---|---|"]
    for item in rows:
        lines.append(f"| {item['id']} | {item['title']} | {'PASS' if item['pass'] else 'FAIL'} | {item['observed']} |")
    problems = [f"- {item['id']}: {problem}" for item in rows for problem in item["problems"]]
    if problems:
        lines += ["", "## Problems", *problems]
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / f"{stem}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (OUTPUT / f"{stem}.json").write_text(json.dumps({"generated": datetime.now().isoformat(timespec="seconds"), "summary": summary, "rows": rows}, indent=2), encoding="utf-8")
    print("\n".join(lines))


def print_summary(rows, summary, redirect_to, width=104):
    """Short console view: one wrapped line per scenario, demo inbox address hidden."""
    for item in rows:
        observed = item["observed"].replace(redirect_to, "demo inbox") if redirect_to else item["observed"]
        words, line, out = observed.replace("; ", ", ").split(" "), "", []
        for word in words:
            if line and len(line) + 1 + len(word) > width - 10:
                out.append(line)
                line = word
            else:
                line = f"{line} {word}".strip()
        out.append(line)
        print(f"{item['id']:<4}{'PASS' if item['pass'] else 'FAIL'}  {out[0]}")
        for extra in out[1:]:
            print(f"{'':10}{extra}")
    extra = f", extra {summary['extra_passed']} / {summary['extra_total']}" if summary["extra_total"] else ""
    print(f"{summary['passed']} / {summary['total']} passed{extra}, {summary['demo_records']} demo Leads and Contacts in Salesforce")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--replay", action="store_true")
    parser.add_argument("--summary", action="store_true", help="print a short per-scenario view instead of the Markdown table")
    args = parser.parse_args()
    values = load_env()
    fixtures, reviews = load_fixtures()
    client = client_from_env(values)
    all_logs = read_json_files(RUN_LOG_DIR)
    if args.replay:
        replay = latest_send_log("replay")
        if not replay:
            raise SystemExit("No replay batch found; run send_fixtures.py --replay first.")
        before = json.loads((OUTPUT / "results.json").read_text(encoding="utf-8"))["summary"]["demo_records"] if (OUTPUT / "results.json").exists() else None
        rows, summary = evaluate_replay(fixtures, logs_since(all_logs, replay["run_started"]), replay, before, len(client.demo_people()))
        write_results(rows, summary, "Replay check (same batch sent twice)", stem="results-replay")
        return
    batch = latest_send_log("initial")
    if not batch:
        raise SystemExit("No initial batch found; run send_fixtures.py first.")
    logs = logs_since(all_logs, batch["run_started"])
    rows, summary = evaluate(fixtures, reviews, logs, batch, latest_send_log("review"), salesforce_state(client),
                             demo_inbox_replies(values, batch["run_started"]), values.get("REPLY_REDIRECT_TO", "").lower(), load_seed()[0]["email"])
    if args.summary:
        print_summary(rows, summary, values.get("REPLY_REDIRECT_TO", "").lower())
        return
    write_results(rows, summary, "Lead intake test results (T1–T8, plus T9)")


if __name__ == "__main__":
    main()
