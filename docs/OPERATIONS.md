# Operations guide

For the team running this day to day. Most changes are a text edit followed by two commands:

```powershell
node n8n-src/build-workflows.mjs
python scripts/n8n_setup.py --skip-credentials
```

The first rebuilds the workflow files, the second imports and publishes them. Don't edit the workflows in the n8n editor if you plan to rebuild, because the rebuild overwrites them. Make the change in the source files instead.

## Daily use

1. A new lead posts to Slack: `New lead: <name> (<tier>, <urgency> urgency) — review the draft reply: <link>`.
2. Open the link. The page shows the original message, the AI's tier and reason, and a link to the Lead or Contact in Salesforce.
3. Edit the draft if needed, pick **Approve and send** or **Reject, send nothing**, type your name and submit.
4. The decision is saved as a completed Task on the record ("AI reply approved by …"). Opening the link again shows "Already reviewed".

Some leads get no draft: Not qualified ones (pitches, job applications, home cleaning) and any the AI couldn't classify. They are still saved to Salesforce. Filter a Lead list view by **Lead Tier** to find them.

Every inquiry is a completed Task named `Inquiry via form: …` or `Inquiry via email: …` on the record, with the full message and the AI's reason in the description.

Known gaps to watch for when reviewing:

- The draft only sees the current message, so on a follow-up it may ask for details the person already gave. Check the record's earlier inquiry Tasks and edit the draft before approving.
- The draft can sound more certain than it should, for example "we can definitely add that on your next visit". Take out promises about dates or prices before approving.

## Where inquiries go

- An existing **Contact** with the same email (or the same phone) gets the inquiry. No Lead is created for a known customer.
- Otherwise an existing, unconverted **Lead** gets it.
- Otherwise a new Lead is created. Contacts are never created and Leads are never converted by the workflow.

[FIELD-MAPPING.md](FIELD-MAPPING.md) lists every field the workflow writes and which ones it only fills when empty.

## Changing the sorting rules

The rules are plain English in [../prompts/qualify.md](../prompts/qualify.md), under **System**. For example, to accept residential work, move "home cleaning" out of the not_qualified line and describe when it counts as qualified. Rebuild and re-import afterwards.

The reply style lives in [../prompts/draft-reply.md](../prompts/draft-reply.md) the same way.

Test a rule change in mock mode first, then do one live run (see SETUP §6). In mock mode the AI answers come from `sample-data/mock-llm/`, so mock runs only test the plumbing, not the new wording.

## Adding a topic or tier value

Values have to match in three places:

1. The JSON schema enum in `prompts/qualify.md`
2. The `TOPICS` / `TIERS` / `URGENCIES` list in `n8n-src/code/llm.js`
3. The picklist values in Salesforce, on both Lead and Contact

The picklists are restricted, so Salesforce refuses a value it doesn't know. `salesforce_setup.py` only creates missing fields; it doesn't add values to existing ones. Add the value in Object Manager → Lead (and Contact) → the field → **Values**, update the list in `scripts/salesforce_setup.py` so a fresh org gets it too, then run the unit tests, rebuild and re-import.

## Adding a new source

Any channel can feed the same pipeline. Turn the incoming message into the inquiry shape below, then call the **Lead intake: process inquiry** workflow with an *Execute Workflow* node, the way the form and email workflows do.

```json
{
  "source": "form",
  "source_id": "form:<unique id from the channel>",
  "received_at": "2026-10-30T09:00:00.000Z",
  "name": "Dana Whitfield",
  "email": "dana@example.com",
  "phone": "+15105550142",
  "company": "Harborview Dental Group",
  "subject": "Website contact form",
  "message": "The message text",
  "demo_flags": { "break_llm": false }
}
```

- `source_id` must be unique and stable for the same message. That's what stops duplicates, so use the channel's own message ID rather than a timestamp. Salesforce also refuses a second Task with the same `Inquiry_Source_ID__c`.
- At least one of `email` or `phone` is required. Use `normalize.js` (`toE164`, `validateInquiry`) so phone numbers match existing records.
- `Inquiry_Source__c` only allows `form` and `email`. Add the new source as a picklist value on Lead and Contact first.

## Reading the run log

Every inquiry writes one JSON file to `output/run-log/`:

| Field | Meaning |
|---|---|
| `action` | `created`, `updated`, `duplicate_submission` or `rejected_input` |
| `record_type`, `record_id` | The Lead or Contact the inquiry went to |
| `matched_by` | How it was found: `contactEmail`, `leadEmail`, `contactPhone`, `leadPhone`, `phoneSearch`, `duplicateRule`, or empty for a new Lead |
| `tier`, `llm_ok`, `llm_error` | The AI's result; `llm_ok: false` means the fallback was used |
| `draft` | `none`, `approved`, `rejected` or `timeout` |
| `reviewer`, `edited`, `sent_to` | Who decided, whether they changed the draft, where it went |
| `alerts` | Slack messages sent for this inquiry |

`errors.jsonl` in the same folder lists workflow failures caught by the error handler.

## Slack alerts

| Alert | What to do |
|---|---|
| `Inquiry not accepted (no_contact)` | The sender left no email or phone. Nothing was saved; follow up by hand if you can tell who it was. |
| `AI classification failed (...)` | The lead is in Salesforce as Needs review with no draft. Open it, decide the tier yourself and reply manually. `api_error_429` usually means the OpenAI account is out of credit. |
| `AI reply draft failed (...)` | The lead was classified, but there's no draft. Reply from Salesforce directly. |
| `Lead intake workflow error` | Something failed outside the expected paths, for example a Salesforce error during the lookup. The alert links to the failed n8n execution. |

## Rotating keys

1. Create the new secret (Salesforce: a new Consumer Secret from the External Client App's OAuth settings, or a new app; OpenAI: a new key; Gmail: a new app password) and put it in `.env`.
2. `python scripts/n8n_setup.py` re-imports the credentials with the new values.
3. Revoke the old one once a test inquiry goes through.

Keep `N8N_ENCRYPTION_KEY` unchanged through all of this.

## Leaving demo mode

`DEMO_MODE=1` blocks every sender outside `example.com` / `example.org` (and phone-only inquiries outside the fictional 555-01xx range) and sends approved replies to `REPLY_REDIRECT_TO`. Before setting `DEMO_MODE=0` for real use, put n8n on a host the team can reach, add access control in front of the review page, give the Run As user only the permissions it needs, and run one live test with an address you own.
