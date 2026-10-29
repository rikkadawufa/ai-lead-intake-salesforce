import unittest

from scripts.collect_results import evaluate, evaluate_replay, find_log, logs_since
from scripts.compare_results import HUBSPOT, compare, load, render
from scripts.demo_common import load_fixtures, load_seed, safe_id, source_id

FIXTURES, REVIEWS = load_fixtures()
SID = {fixture["id"]: source_id(fixture, FIXTURES) for fixture in FIXTURES}
REDIRECT = "leads+replies@gmail.com"
EDITED = next(line for line in REVIEWS[0]["edit_body"].split("\n") if len(line) > 60)
SEED = load_seed()[0]["email"]


def log(fid, action, **extra):
    return {"ts": "2026-10-30T00:00:01", "source_id": SID[fid], "action": action, "alerts": [], "draft": "none", **extra}


def passing_inputs():
    logs = [
        log("T1", "created", record_type="Lead", tier="qualified", draft="approved", edited=True, record_id="00Q1", sent_to=REDIRECT, reviewer="Morgan Lee (Ops)"),
        log("T2", "updated", record_type="Lead", record_id="00Q1", draft="approved", edited=False),
        log("T3", "duplicate_submission", record_id="00Q1"),
        log("T4", "created", tier="not_qualified", record_id="00Q2"),
        log("T5", "created", tier="needs_review", draft="rejected", record_id="00Q3", sent_to=None),
        log("T6", "rejected_input", alerts=["x"]),
        log("T7", "created", tier="needs_review", llm_ok=False, record_id="00Q4", alerts=["x"]),
        log("T9", "updated", record_type="Contact", record_id="003S", draft="rejected"),
    ]
    send_log = {"results": [{"id": "T6", "http_status": 400}]}
    review_log = {"results": [{"fixture": "T1", "incomplete_review_status": 422}]}
    people = [
        {"type": "Lead", "id": "00Q1", "email": "dana.whitfield@example.com", "inquiry_tasks": 2, "lead_tier": "qualified"},
        {"type": "Contact", "id": "003S", "email": SEED, "inquiry_tasks": 1, "lead_tier": "qualified"},
    ]
    mail = [{"to": REDIRECT, "subject": "[demo → dana] a", "body": EDITED}, {"to": REDIRECT, "subject": "[demo → dana] b", "body": "other"}]
    return logs, send_log, review_log, people, mail


def run(logs, send_log, review_log, people, mail):
    return evaluate(FIXTURES, REVIEWS, logs, send_log, review_log, people, mail, REDIRECT, SEED)


class ResultTests(unittest.TestCase):
    def test_all_pass_on_expected_state(self):
        rows, summary = run(*passing_inputs())
        self.assertEqual((summary["passed"], summary["total"]), (8, 8), [row["problems"] for row in rows if not row["pass"]])
        self.assertEqual((summary["extra_passed"], summary["extra_total"]), (1, 1))

    def test_second_lead_for_the_same_person_fails_t2(self):
        logs, *rest = passing_inputs()
        logs[1]["record_id"] = "00Q9"
        rows, _ = run(logs, *rest)
        self.assertFalse(next(row for row in rows if row["id"] == "T2")["pass"])

    def test_a_sent_rejected_reply_fails_t5_and_t8(self):
        logs, *rest = passing_inputs()
        logs[4]["sent_to"] = REDIRECT
        rows, _ = run(logs, *rest)
        self.assertEqual({row["id"] for row in rows if not row["pass"]}, {"T5", "T8"})

    def test_existing_contact_turned_into_a_lead_fails_t9_only(self):
        logs, send_log, review_log, people, mail = passing_inputs()
        logs[7].update(action="created", record_type="Lead", record_id="00Q5")
        people.append({"type": "Lead", "id": "00Q5", "email": SEED, "inquiry_tasks": 1})
        rows, summary = run(logs, send_log, review_log, people, mail)
        self.assertEqual({row["id"] for row in rows if not row["pass"]}, {"T9"})
        self.assertEqual(summary["passed"], 8)

    def test_replay_requires_duplicates_and_same_record_count(self):
        logs = [log(fid, "duplicate_submission") for fid in ("T1", "T2", "T3", "T4", "T5", "T7", "T9")]
        rows, summary = evaluate_replay(FIXTURES, logs, {"results": [{"id": "T6", "http_status": 400}]}, 5, 5)
        self.assertEqual(summary["passed"], summary["total"])
        _, changed = evaluate_replay(FIXTURES, logs, {"results": [{"id": "T6", "http_status": 400}]}, 5, 6)
        self.assertEqual(changed["passed"], changed["total"] - 1)

    def test_helpers(self):
        self.assertEqual(safe_id("email:<t2@example.com>"), "email_t2_example.com")
        self.assertEqual(SID["T3"], SID["T1"])
        self.assertEqual(len(logs_since([{"ts": "2026-10-28"}, {"ts": "2026-10-30"}], "2026-10-29")), 1)
        self.assertIsNone(find_log([], "x"))


class CompareTests(unittest.TestCase):
    def test_side_by_side_lists_t1_to_t9_with_both_scores(self):
        rows, summary = run(*passing_inputs())
        salesforce = {"generated": "2026-10-30T10:00:00", "summary": summary, "rows": rows}
        hubspot = load(HUBSPOT)
        lines, hub_score, sf_score = compare(hubspot, salesforce)
        self.assertEqual(len(lines), 9)
        self.assertEqual((hub_score, sf_score), ("8 / 8", "8 / 8"))
        self.assertIn("| T9 | Existing customer (a Contact) writes in | not in the HubSpot run | PASS |", lines)
        self.assertNotIn("@gmail.com", render(hubspot, salesforce, "mock run"))


if __name__ == "__main__":
    unittest.main()
