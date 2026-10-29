"""Send the T1–T7 and T9 fixtures (form POSTs and SMTP test emails) and run the T8 reviews (plus T9's).

  python scripts/send_fixtures.py --dry-run          # print what would be sent
  python scripts/send_fixtures.py                    # send the fixtures, one every --gap seconds
  python scripts/send_fixtures.py --review           # submit the T8 review decisions
  python scripts/send_fixtures.py --replay           # send the same batch again (idempotency check)
"""
import argparse
import json
import smtplib
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr

try:
    from .demo_common import FORM_URL, OUTPUT, REVIEW_DIR, base_fixture, load_fixtures, safe_id, source_id
    from .envfile import load_env, mask, require
except ImportError:
    from demo_common import FORM_URL, OUTPUT, REVIEW_DIR, base_fixture, load_fixtures, safe_id, source_id
    from envfile import load_env, mask, require


def now():
    return datetime.now(timezone.utc).isoformat()


def http_post(url, data, headers):
    request = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")


def form_request(fixture, fixtures):
    base = base_fixture(fixture, fixtures)
    body = {**base["payload"], "submission_id": base["submission_id"]}
    headers = {"Content-Type": "application/json"}
    if base.get("break_llm"):
        headers["x-demo-break-llm"] = "1"
    return body, headers


def email_message(fixture, gmail):
    message = EmailMessage()
    message["From"] = formataddr((f"{fixture['from_name']} (demo sender)", gmail))
    message["To"] = gmail
    message["Reply-To"] = formataddr((fixture["from_name"], fixture["reply_to"]))
    message["Subject"] = fixture["subject"]
    message["Message-ID"] = fixture["message_id"]
    message.set_content(fixture["body"])
    return message


def describe(fixture, fixtures):
    if base_fixture(fixture, fixtures)["channel"] == "form":
        body, headers = form_request(fixture, fixtures)
        extra = " + header x-demo-break-llm: 1" if "x-demo-break-llm" in headers else ""
        return f"POST {FORM_URL}{extra}\n    {json.dumps(body)}"
    return f"SMTP email to the demo inbox, Reply-To: {fixture['from_name']} <{fixture['reply_to']}>, Message-ID {fixture['message_id']}\n    Subject: {fixture['subject']}"


def send_batch(values, fixtures, only, gap, mode, dry_run):
    selected = [fixture for fixture in fixtures if not only or fixture["id"] in only]
    if dry_run:
        for fixture in selected:
            print(f"[{fixture['id']}] {fixture['title']}\n  {describe(fixture, fixtures)}")
        return None
    gmail = require(values, "GMAIL_ADDRESS")
    password = require(values, "GMAIL_APP_PASSWORD").replace(" ", "")
    log = {"mode": mode, "run_started": now(), "results": []}
    for index, fixture in enumerate(selected):
        if index:
            time.sleep(gap)
        entry = {"id": fixture["id"], "source_id": source_id(fixture, fixtures), "sent_at": now()}
        try:
            if base_fixture(fixture, fixtures)["channel"] == "form":
                body, headers = form_request(fixture, fixtures)
                status, text = http_post(FORM_URL, json.dumps(body).encode("utf-8"), headers)
                entry.update({"channel": "form", "http_status": status, "response": text[:300]})
            else:
                with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context()) as smtp:
                    smtp.login(gmail, password)
                    smtp.send_message(email_message(fixture, gmail))
                entry.update({"channel": "email", "smtp": "sent"})
        except Exception as error:  # keep going so one failure is visible next to the others
            entry.update({"error": mask(f"{type(error).__name__}: {error}", values)})
        print(f"[{fixture['id']}] {entry.get('http_status', entry.get('smtp', entry.get('error')))}")
        log["results"].append(entry)
    log["run_finished"] = now()
    return log


def submit_reviews(values, fixtures, reviews):
    log = {"mode": "review", "run_started": now(), "results": []}
    by_fixture = {fixture["id"]: fixture for fixture in fixtures}
    for index, review in enumerate(reviews):
        sid = source_id(by_fixture[review["fixture"]], fixtures)
        meta_path = REVIEW_DIR / f"{safe_id(sid)}.json"
        if not meta_path.exists():
            print(f"[{review['fixture']}] no review page yet ({meta_path.name}); is the draft still being made?")
            log["results"].append({"fixture": review["fixture"], "error": "no_review_page"})
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        entry = {"fixture": review["fixture"], "decision": review["decision"]}
        if index == 0:
            # Show that an incomplete review is refused and nothing is sent.
            status, _ = http_post(meta["resume_url"], urllib.parse.urlencode({"decision": review["decision"]}).encode(), headers)
            entry["incomplete_review_status"] = status
            time.sleep(3)
        fields = {"reviewer": review["reviewer"], "decision": review["decision"]}
        if review.get("edit_body"):
            fields["body"] = review["edit_body"]
        status, text = http_post(meta["resume_url"], urllib.parse.urlencode(fields).encode(), headers)
        entry.update({"http_status": status, "response": text[:200]})
        print(f"[{review['fixture']}] {review['decision']} -> {status}" + (f" (incomplete first try -> {entry['incomplete_review_status']})" if "incomplete_review_status" in entry else ""))
        log["results"].append(entry)
        time.sleep(3)
    log["run_finished"] = now()
    return log


def save(log):
    OUTPUT.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = OUTPUT / f"send-log-{log['mode']}-{stamp}.json"
    path.write_text(json.dumps(log, indent=2), encoding="utf-8")
    print(f"Saved {path.relative_to(OUTPUT.parent)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated fixture ids, e.g. T1,T2")
    parser.add_argument("--gap", type=float, default=8.0, help="seconds between sends (lets each inquiry finish before the next one for the same person arrives)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--review", action="store_true", help="submit the review decisions (T8, and T9's reject)")
    parser.add_argument("--replay", action="store_true", help="send the same batch again")
    args = parser.parse_args()
    values = load_env()
    fixtures, reviews = load_fixtures()
    if args.review:
        save(submit_reviews(values, fixtures, reviews))
        return
    only = set(args.only.split(",")) if args.only else None
    log = send_batch(values, fixtures, only, args.gap, "replay" if args.replay else "initial", args.dry_run)
    if log:
        save(log)


if __name__ == "__main__":
    main()
