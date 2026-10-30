# Verification log

Environment: local Docker n8n 2.44.7 (port 5680, compose project `lead-intake-sf-demo`), Salesforce Developer Edition (API v63.0, External Client App + client credentials), the demo Gmail account (carried over from the HubSpot version), and a new Slack webhook (`#lead-alerts-salesforce`). Check IDs follow `SPEC.md` §9. Date 2026-10-30 (Taiwan time).

## 9.1 Offline
| ID | Command | Result |
|---|---|---|
| O1 | `node --test "n8n-src/code/*.test.js" "n8n-src/*.test.mjs"` | **PASS**: all 57 tests pass |
| O2 | `python -m unittest discover tests_scripts` | **PASS**: all 25 tests pass |
| O3 | `node n8n-src/build-workflows.mjs` run twice and compared | **PASS**: 5 workflows, identical output both times; Code node syntax check found 0 errors; no mention of HubSpot |
| O4 | `python scripts/send_fixtures.py --dry-run` | **PASS**: lists T1–T7 and T9, with no secrets |

## 9.2 Local n8n (mock LLM, real Salesforce/Gmail/Slack)
| ID | Result |
|---|---|
| N1 | **PASS**: `salesforce_setup.py` created 13 fields, the permission set (13 field permissions) and its assignment, and T9's demo Account and Contact; a second run skipped everything. The Task field `Inquiry_Source_ID__c` reads back as unique + externalId + caseSensitive (Developer Edition accepts it; no fallback to a plain field) |
| N2 | **PASS**: n8n's `oAuth2Api` credential (client credentials) fetched its own token, and the Composite lookup succeeded. A token refresh on 401 hasn't happened yet, so that part is unverified |
| N3 | **PASS**: `reset_demo.py --apply` deleted the demo records and recreated Avery: 0 demo Leads, 1 Contact |
| N4 | **PASS 8/8 + T9**: `send_fixtures.py` → `--review` → `collect_results.py`. Salesforce has 4 Leads (Dana, Jordan, Sam, Riley) + Avery's Contact. Dana has 2 inquiry Tasks + 2 decision Tasks. T9 is attached to Avery's Contact, with no Lead created. The demo inbox has 2 emails |
| N5 | **PASS 9/9**: `send_fixtures.py --replay` resent the whole batch (including 3 emails with the same Message-ID) → all 7 were `duplicate_submission`, no new drafts, T6 still a 400, and still 5 Leads/Contacts |
| N6 | **PASS** (two extra forms sent by hand, not part of T1–T9. They have no mock answers, so the AI took the failure path and Slack got alerts; only the matching is checked here):<br>・(a) phone only, `510.555.0177`, no email → `matched_by=leadPhone`, updated Riley's existing Lead<br>・(b) first created a "typed by hand" Lead through the API (Jamie, `(510) 555-0199`, no E.164 field), then about 5 minutes later sent a phone-only form with `510-555-0199` → `matched_by=phoneSearch`, updated the same Lead, left `Phone` unchanged, and filled in `Phone_E164__c` as `+15105550199`. Neither created a new Lead |

## 9.3 E2E (real OpenAI, gpt-4.1-mini; run after the user approved it on 2026-10-30)
| ID | Result |
|---|---|
| E1 | **PASS: live round 1, T1–T8 8/8, T9 PASS** (04:05–04:07 Taiwan time; only 1 round run). Logs are in `output/archive-live-round-1/`, and a copy with the inbox address removed is in `results/salesforce-live-round-1.json` |
| E2 | **PASS**: `compare_results.py` produced the side-by-side table, HubSpot 8/8 and Salesforce 8/8 (`output/results-side-by-side.md`) |
| E3 | **PASS**: the demo inbox has exactly 2 approved replies (T1 edited, T2 original). T5 and T9 were rejected and nothing was sent |
| E4 | **NOT RUN**: Salesforce UI screenshots are taken by the user (in the portfolio step) |

I also tested the unique constraint directly through the API: creating another Task on Dana's Lead with `Inquiry_Source_ID__c = form:tw-demo-0001` → Salesforce returned 400 `DUPLICATE_VALUE` and didn't save it. So Salesforce itself blocks a second Task with the same source ID; it isn't only the lookup.

A note on the side-by-side table: the HubSpot column is its live **round 2** (round 1 was 4/8, rerun after fixing the quote length check). This Salesforce run used the same, already fixed `llm.js`, so it scored 8/8 in round 1.

### How the real AI rated each fixture
| # | AI rating | vs. expected |
|---|---|---|
| T1 | qualified (run log) | Match |
| T2 | needs_review ("no square footage or frequency"); the Lead stays qualified under the no-downgrade rule | Match (final tier) |
| T4 | not_qualified/sales_pitch/low | Match |
| T5 | needs_review/quote_request/normal | Match |
| T7 | OpenAI really returned 404 → needs_review, alert | Match |
| T9 | qualified/deep_cleaning/normal | Match |

### Limits the live run exposed
- **The draft can't see the person's earlier inquiries** (same as the HubSpot version): T2's draft asked Dana again how big the office is and how often it needs cleaning, which she'd already said in T1. Per the fixture, it was approved unedited and sent.
- **`AI_Reason__c` follows the latest email, while tier keeps the higher rating** (same as the HubSpot version): Dana is qualified, but the reason is T2's "no square footage or frequency".
- **T9's draft overpromises a bit**: "We can definitely add carpet cleaning … during your next monthly deep clean", even though the prompt says not to commit to dates. Per the fixture it was rejected and never sent, which is exactly what human approval is for.
- Switched back to `LLM_MODE=mock` after the run. Salesforce still has this round's 4 Leads + Avery's Contact for screenshots.

## Problems found and fixed during development
1. **Composite doesn't accept SOSL.** On the first T1 send, the `phoneSearch` subrequest returned 404 `NOT_FOUND`. The matching code threw as designed and the error workflow sent a Slack alert, so it was never treated as "not found". It's now a separate HTTP node that only searches when neither the email nor the stored phone matched.
2. **SOSL phone format.** `FIND {+1…}` returned `MALFORMED_SEARCH` (the `+` is read as a bind variable), and `510-555-0188` is also a syntax error. Sending just the 10 digits finds records stored as `+15105550188`. New records take a few minutes to become searchable (right after Avery was created the search found nothing; a few minutes later it did).
3. **Demo mode blocked phone-only inquiries.** The rule carried over from the HubSpot version was "reject anything without an `@example` email", so phone-only inquiries could never get in (which is why the HubSpot version's phone matching never fired). Demo mode now also accepts inquiries with a phone in the fictional 555-0100–0199 range, and reset clears those records too.
4. **Every form inquiry Task had the same subject.** After normalizing, form subjects were always `Website contact form`, so the Task list couldn't tell them apart. Form inquiries now use the start of the message as the subject; email inquiries still use the email subject.

## Differences from SPEC (SPEC updated to match)
- The phone search moved out of Composite (SPEC §4, step 2.5).
- The demo write scope now includes 555-01xx phone numbers (SPEC §1, rule 6).

## What's in Salesforce right now
- The 5 demo records from live round 1 (Leads for Dana, Jordan, Sam, and Riley; Avery's Contact). **Don't reset or rerun until the screenshots are taken.**
- An early T1 test left one n8n execution waiting for review (old workflow version) that times out around 2026-11-02. Its Lead has already been deleted, so writing the Task on timeout will fail and may send an error alert. It doesn't affect the results.

## To do
- None (README, SETUP, and OPERATIONS have been rewritten for Salesforce, and the README went through humanizer).
