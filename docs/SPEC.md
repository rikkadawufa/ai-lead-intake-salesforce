# Implementation spec: AI Lead Intake → Salesforce (n8n + OpenAI)

> The reasoning behind this project lives in internal planning notes that are not part of this repo. This file is the spec to build from. It follows the structure of the HubSpot version (`2026-10-28_n8n-lead-intake-hubspot/demo/docs/SPEC.md`) and only covers **what's different**, plus the full acceptance checklist. If the real API behaves differently, log it in `docs/VERIFICATION.md` and make the smallest change that keeps the original intent.
> Code, comments, README, commit messages, and every file under `docs/` are in English.

---

## 0. Prerequisites (done by the user)
- `demo/.env` has `SF_INSTANCE_URL` (My Domain), `SF_CLIENT_ID`, and `SF_CLIENT_SECRET` filled in, along with `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`, `SLACK_WEBHOOK_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, and `REPLY_REDIRECT_TO` carried over from the HubSpot version.
- Docker Desktop is running, and n8n is at http://localhost:5680 (compose project name `lead-intake-sf-demo`, with volumes separate from the HubSpot version).
- If any value is missing, only build the offline parts and note in VERIFICATION.md what went untested.

## 1. Hard rules (same as the HubSpot version, with the CRM swapped)
1. No package installs: Python uses only the standard library, and Node uses only built-in modules.
2. Secrets are never printed, logged, or committed. Tokens and secrets in error messages are replaced with `***`.
3. No paid resources. Salesforce stays on Developer Edition.
4. No `git push` and no GitHub repo creation.
5. Development always runs with `LLM_MODE=mock`. Live runs happen only in §9.3, each round needs the user's OK first, and there are at most 3 rounds.
6. **Salesforce write scope:** only touch Leads and Contacts whose email ends in `@example.com` or `@example.org` (or that have no email and a phone number in the fictional 555-0100–0199 range), plus the Tasks under them. Reset deletes only those, plus the demo Account named in §8.2. In demo mode, phone-only inquiries are accepted only from that range.
7. Outgoing email: with `DEMO_MODE=1`, everything goes to `REPLY_REDIRECT_TO` with `[demo → <original recipient>]` added to the subject.

## 2. File layout (differences from the HubSpot version)
- `scripts/salesforce_client.py` replaces `hubspot_client.py`: client credentials token exchange, REST/Tooling requests, SOQL paging, retries, masking.
- `scripts/salesforce_setup.py` replaces `hubspot_setup.py`: creates the custom fields, the permission set and its assignment, and the demo Contact for T9.
- `scripts/compare_results.py` (new): side-by-side HubSpot/Salesforce table.
- `results/hubspot-live-round-2.json` (new): a copy of the HubSpot version's live round 2 results, with the demo inbox address replaced by `demo inbox`.
- `n8n-src/code/match.js` replaces `contact.js`; notes in `records.js` become Tasks.
- `docs/FIELD-MAPPING.md` (new): the field mapping table.

## 3. Data formats
### 3.1 Inquiry: same as the HubSpot version (no logic changes in `normalize.js`).

### 3.2 Salesforce custom fields (created by `salesforce_setup.py` through the Tooling API; existing ones are skipped)
| Object | API name | Type | Values |
|---|---|---|---|
| Lead, Contact | `Lead_Tier__c` | Picklist (restricted) | `qualified` / `needs_review` / `not_qualified` |
| Lead, Contact | `Inquiry_Topic__c` | Picklist (restricted) | The same 7 as the HubSpot version |
| Lead, Contact | `Inquiry_Urgency__c` | Picklist (restricted) | `high` / `normal` / `low` |
| Lead, Contact | `Inquiry_Source__c` | Picklist (restricted) | `form` / `email` (the most recent) |
| Lead, Contact | `AI_Reason__c` | Long Text Area 32768 | Reason + `Quote: "…"` |
| Lead, Contact | `Phone_E164__c` | Text(16) | The E.164 phone at write time, used for matching |
| Task (Activity) | `Inquiry_Source_ID__c` | Text(255), External ID + Unique + case sensitive (tested 2026-10-30: Developer Edition accepts it) | `form:…` / `email:<Message-ID>` |

- If Activity custom fields don't allow Unique/External ID, fall back to a plain Text field and note it in VERIFICATION. Dedup relies on the §4 lookups, not on this constraint. Don't claim publicly that simultaneous submissions are blocked unless Unique was actually created and tested.
- **Field permissions:** create a permission set `Lead_Intake_Demo` with Read + Edit on every field above, and assign it to the Run As user (user id from `/services/oauth2/userinfo`).
- The Lead→Contact field mapping (carried over on conversion) isn't automated; `docs/SETUP.md` describes it as an optional UI step.

### 3.3 Lead required fields and defaults
- `LastName`: the last name split from the full name. With no name, use the part of the email before `@`. With neither, `(unknown)`.
- `Company`: filled in if given, otherwise `[not provided]`. A later inquiry that includes a company name fills it in (only when the current value is empty or `[not provided]`).
- `LeadSource`: `Web` for forms; not set for email.
- `Phone`, `Phone_E164__c`: E.164.

## 4. Matching, dedup, and idempotency
1. **One Composite request** (`POST /services/data/{v}/composite`, `allOrNone:false`) runs these lookups (the subrequest is skipped when there's no email or phone):
   - `dupTask`: `SELECT Id, WhoId FROM Task WHERE Inquiry_Source_ID__c = '<source_id>' LIMIT 1`
   - `contactEmail`, `leadEmail`: `Email = '<email>'`; the Lead query adds `IsConverted = false`
   - `contactPhone`, `leadPhone`: `Phone_E164__c = '<E.164>'`
   - SOQL strings always escape `\` and `'`. If any subrequest fails (for example, a missing field), throw so the error workflow sends an alert, instead of quietly treating it as "not found".
2. Priority: `contactEmail` → `leadEmail` → `contactPhone` → `leadPhone` (Contacts before Leads).
2.5 If nothing matched, it isn't a resend, and there's a phone, make a **separate** SOSL call `FIND {<10 digits>} IN PHONE FIELDS RETURNING Contact(…), Lead(… WHERE IsConverted = false)` to catch phone numbers typed by hand in a different format. Composite doesn't accept `/search` subrequests (tested: 404), so this can't go in step 1. SOSL doesn't accept `+` or `-`, so send digits only. New records take a few minutes to become searchable.
3. `dupTask` returns a row → stop the whole item; the run log records `duplicate_submission` (`record_id` = that Task's WhoId), with no tiering, no Task, and no draft.
4. Contact found → update the Contact. Lead found → update the Lead. Neither → create a Lead. **Never create a Contact automatically or convert a Lead.**
5. Lead creation returns `DUPLICATES_DETECTED` (blocked by a Salesforce duplicate rule) → take the id and type of the first existing record from `duplicateResult.matchResults` → read its current values → switch to the update path. Other errors are thrown as usual.
6. Update rules match the HubSpot version: a tier that's already qualified is never downgraded, other AI fields take the latest value, and identity fields (FirstName, Email, Phone, Company) are only filled in when empty.
7. Every inquiry creates one Task on that Lead/Contact (`WhoId`): `Subject` = `Inquiry via <source>: <subject or first 60 characters of the message>` (≤255), `Description` = received time + subject + original text + `AI: tier / topic / urgency — reason`, `Status` = `Completed`, `ActivityDate` = received date, `Inquiry_Source_ID__c` = source_id.
8. Record link: `<SF_INSTANCE_URL>/lightning/r/<Lead|Contact>/<id>/view`.

## 5. LLM: identical to the HubSpot version (prompt, schema, model, checks, failure handling, mock).

## 6. Human approval: same as the HubSpot version, with different wording
- Review page link text: `Open record in Salesforce`. Help text: `Your name is saved on the Salesforce record with the decision.`
- The decision is written as a Task (without `Inquiry_Source_ID__c`): `Subject` = `AI reply approved by <reviewer>` / `AI reply rejected by <reviewer>` / `AI reply review timed out`, and `Description` uses the same text as the HubSpot version's note (including the sent subject and body).

## 7. n8n environment
- Image `2.44.7`, port 5680, `WEBHOOK_URL=http://localhost:5680/`.
- Credentials (imported by `n8n_setup.py` with fixed ids):
  - `salesforceOAuthCred01`: `oAuth2Api`, grantType `clientCredentials`, accessTokenUrl `<SF_INSTANCE_URL>/services/oauth2/token`, authentication `body`. n8n fetches the token on first use and fetches a new one on 401.
  - `openAiCred01`, `gmailImapCred01`, `gmailSmtpCred01`: same as the HubSpot version.
- Non-secret environment variables: `SF_INSTANCE_URL`, `SF_API_VERSION` (default `v63.0`; setup confirms the org supports it).

## 8. Workflows and scripts
### 8.1 Workflows (`build-workflows.mjs` generates 5, same names)
- WF1 `wfFormIntake`, WF2 `wfEmailIntake`, WF5 `wfReviewPage`, WF4 `wfErrorHandler`: same as the HubSpot version, with only the wording and port changed.
- WF3 `wfProcessInquiry`: Start → Build lookup → **Salesforce lookup (Composite)** → Resolve match → (no match and has a phone) Phone search → stop if duplicate → qualify → Existing record? → Update record (PATCH) or Create lead (→ on a duplicate rule hit, read the existing record and update it) → Create inquiry task → draft → review → send or don't send → Create decision task → run log.
- Run log fields: `{source_id, fixture_id, record_type, record_id, matched_by, action: created|updated|duplicate_submission|rejected_input, tier, llm_ok, llm_error, draft, reviewer, edited, sent_to, alerts[]}`.

### 8.2 Scripts
- `salesforce_setup.py`: confirm the API version → create missing fields → permission set + field permissions + assignment → create T9's demo Account `Brookside Veterinary (demo)` and Contact `Avery Brooks <avery.brooks@example.com>` (skipped if they exist). `--dry-run` only lists what it would do.
- `reset_demo.py`: dry run by default. `--apply` deletes the demo Leads/Contacts and their Tasks plus the demo Account, clears local output, and **recreates T9's demo Contact**.
- `collect_results.py`: reads the run log + Salesforce + the demo inbox → `output/results.md/json`. T1–T8 count toward "N / 8"; T9 is listed separately.
- `compare_results.py`: `results/hubspot-live-round-2.json` and `output/results.json` → `output/results-side-by-side.md`.

## 9. Acceptance checklist (results go in `docs/VERIFICATION.md`, each marked PASS / FAIL / NOT RUN)
### 9.1 Offline
- O1 `node --test "n8n-src/code/*.test.js" "n8n-src/*.test.mjs"` all pass, including match.js: SOQL escaping, composite assembly (with/without email and phone), match priority, duplicate Task, failing subrequests throw, DUPLICATES_DETECTED parsing, Lead required-field defaults, fill-only-empty fields, no tier downgrade
- O2 `python -m unittest discover tests_scripts` all pass: client token exchange, retries, masking, SOQL paging; setup creates only missing items, field permissions; reset deletes only demo domains; result checks; side-by-side table
- O3 `node n8n-src/build-workflows.mjs` produces 5 JSON files, identical across two runs; the workflows contain no mention of HubSpot and no secrets
- O4 `send_fixtures.py --dry-run` prints what it would send for T1–T9, with no secrets

### 9.2 Local n8n (mock LLM, real Salesforce/Gmail/Slack)
- N1 `salesforce_setup.py` creates the 13 fields, the permission set, and the demo Contact; a second run skips everything
- N2 the n8n credential gets a token through client credentials (one lookup node succeeds)
- N3 after `reset_demo.py --apply`, there are 0 demo Leads and only Avery left as a demo Contact
- N4 one round of T1–T9 → `collect_results.py` reports T1–T8 8/8 and T9 PASS
- N5 resend the whole batch → all `duplicate_submission`, no new drafts, T6 still a 400, Lead/Contact counts unchanged
- N6 phone matching: send a phone-only inquiry with the same number as an existing Lead in a different format → attached to the same record (verifies `phoneSearch`; if indexing lag makes it fail, record that as is)

### 9.3 E2E (real OpenAI; ask the user before each round)
- E1 after a reset, run T1–T9 with `LLM_MODE=live` → record N/8 and T9 as they come out; don't change fixture expectations to make them match
- E2 `compare_results.py` produces the side-by-side table
- E3 the demo inbox has exactly 2 approved replies
- E4 Salesforce UI screenshots (taken by the user): the Lead list (tier column), Dana's Lead with 2 inquiry Tasks + 2 decision Tasks, and the Task under Avery's Contact

### 9.4 Expected results (`expect` in `fixtures.json`)
| # | Expected |
|---|---|
| T1 | Lead created, qualified, draft edited then approved |
| T2 | updated, same Lead, 2 inquiry Tasks on that Lead, final tier qualified, approved unedited |
| T3 | duplicate_submission, same Lead, T1 has only 1 draft |
| T4 | Lead created, not_qualified, no draft |
| T5 | Lead created, needs_review, draft rejected, nothing sent |
| T6 | HTTP 400, Slack alert, nothing written to Salesforce |
| T7 | Lead created, needs_review, llm_ok=false, no draft, Slack alert |
| T8 | incomplete review returns 422; T1 approved + edited; T2 approved unedited; T5 rejected; 2 emails in the inbox |
| T9 | existing Contact Avery writes in → updated, record_type Contact, same Contact id, no Lead created, inquiry Task on the Contact; draft rejected |

## 10. Documentation
- `README.md` (English, run through humanizer): what it does, architecture, how to run it, what was tested, **what it doesn't do**, a link to the HubSpot version, `## Running this for your own team`, and the License line (DESIGN.md §15.2).
- `docs/SETUP.md` (English): from scratch through a full T1–T9 run, including the External Client App steps.
- `docs/OPERATIONS.md` (English): changing the tier rules, adding picklist values (in both Salesforce and the schema), adding a new source, reading the run log, handling alerts, rotating the Consumer Secret.
- `docs/FIELD-MAPPING.md` (English): input fields → Lead/Contact/Task fields, defaults, and which ones are only filled when empty.
- `docs/VERIFICATION.md` (English).
