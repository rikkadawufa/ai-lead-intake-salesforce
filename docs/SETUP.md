# Setup

How to get from an empty machine to the T1 to T9 results. The commands are for PowerShell on Windows and work in bash with small changes.

## Requirements

- Docker Desktop
- Python 3.12 and Node.js 24 (standard library and built-ins only, nothing to install)
- A Salesforce org with API access. This was tested on a free Developer Edition org (https://developer.salesforce.com/signup).
- A Gmail address used only for this demo, with 2-Step Verification on
- An OpenAI API key with credit (only needed for live mode; mock mode is free)
- A Slack workspace where you can add an incoming webhook

## 1. Salesforce: an External Client App for n8n

The workflows call the Salesforce REST API with the OAuth 2.0 client credentials flow. Salesforce runs those calls as one "Run As" user.

1. Setup → **My Domain**. Copy the current My Domain URL (for example `https://yourname-dev-ed.develop.my.salesforce.com`).
2. Setup → **External Client App Manager** → **New External Client App**. Name it `n8n Lead Intake`, distribution state **Local**.
3. Turn on **Enable OAuth**:
   - Callback URL: `http://localhost:5680/rest/oauth2-credential/callback` (required by the form, not used by this flow)
   - Scopes: `Manage user data via APIs (api)` and `Perform requests at any time (refresh_token, offline_access)`
   - Flow enablement: **Enable Client Credentials Flow**
4. After creating it, open **Policies** → **Edit**, tick **Enable Client Credentials Flow** under the OAuth policies, and set **Run As** to the username of the user the calls should run as. Save.
5. **Settings** → **OAuth Settings** → **Consumer Key and Secret**. Salesforce emails a verification code first. A new app can take a few minutes to start working.

If your org only offers **App Manager → New Connected App**, the same settings apply there.

## 2. `.env`

Copy `.env.example` to `.env` and fill it in. Never commit `.env`; it's in `.gitignore`.

| Variable | Where it comes from |
|---|---|
| `SF_INSTANCE_URL` | The My Domain URL from step 1 |
| `SF_CLIENT_ID` | Consumer Key |
| `SF_CLIENT_SECRET` | Consumer Secret |
| `SF_API_VERSION` | `v63.0` was used for testing. `salesforce_setup.py` stops with the newest available version if yours isn't supported. |
| `GMAIL_ADDRESS` | The demo inbox |
| `GMAIL_APP_PASSWORD` | https://myaccount.google.com/apppasswords (needs 2-Step Verification). Spaces are fine. |
| `SLACK_WEBHOOK_URL` | https://api.slack.com/apps → your app → Incoming Webhooks → add one for the alerts channel |
| `OPENAI_API_KEY` | https://platform.openai.com/api-keys. A restricted key with **Model capabilities: Write** is enough. |
| `OPENAI_MODEL` | `gpt-4.1-mini` was used for testing |
| `LLM_MODE` | `mock` (default) or `live` |
| `DEMO_MODE` | `1` keeps everything inside the demo: only `@example.com` / `@example.org` senders (or phone-only inquiries from the fictional 555-0100 to 555-0199 range) reach Salesforce, and approved replies go to `REPLY_REDIRECT_TO` |
| `REPLY_REDIRECT_TO` | Where approved replies go in demo mode, for example `yourdemo+replies@gmail.com` |
| `N8N_ENCRYPTION_KEY` | Any long random string. Keep it: changing it later makes n8n unable to read its stored credentials. |
| `N8N_VERSION` | `2.44.7` |

## 3. Salesforce fields

```powershell
python scripts/salesforce_setup.py --dry-run
python scripts/salesforce_setup.py
```

This creates six custom fields on Lead and on Contact and one on Task (listed in [FIELD-MAPPING.md](FIELD-MAPPING.md)). It also creates a permission set with read and edit access to them, assigns it to the Run As user, and creates the existing customer that T9 writes in as (Avery Brooks, a Contact at "Brookside Veterinary (demo)"). Running it again skips what already exists.

To see the fields on the Lead and Contact record pages, add them to the page layouts in Object Manager. The workflows don't need that.

Optional: to carry the fields over when a Lead is converted, map them in Object Manager → Lead → Fields & Relationships → **Map Lead Fields**. This wasn't automated or tested.

## 4. Start n8n and import the workflows

```powershell
docker compose up -d
node n8n-src/build-workflows.mjs
python scripts/n8n_setup.py
```

`build-workflows.mjs` generates the five workflow files in `workflows/` from `n8n-src/code/*.js` and the prompts. `n8n_setup.py` imports four credentials (Salesforce, OpenAI, Gmail IMAP, Gmail SMTP) through a temp file that is deleted right after, imports the workflows, publishes them and restarts n8n. Give the webhooks a few seconds to register after the restart.

The Salesforce credential is an n8n OAuth2 credential with the client credentials grant. n8n fetches the token itself the first time a workflow calls Salesforce.

The editor runs at http://localhost:5680. Create the local owner account there the first time if you want to look at the workflows; the import doesn't need it. Port 5680 is used so this can run next to other n8n instances on 5678 and 5679.

## 5. Run the tests

```powershell
python scripts/reset_demo.py            # dry run: lists what would be deleted
python scripts/reset_demo.py --apply    # deletes demo Leads, Contacts and their Tasks, clears output/, recreates T9's Contact
python scripts/send_fixtures.py --dry-run
python scripts/send_fixtures.py         # T1–T7 and T9, one every 8 seconds
python scripts/send_fixtures.py --review   # T8 (and T9's reject): the review decisions
python scripts/collect_results.py       # writes output/results.md
python scripts/compare_results.py       # writes output/results-side-by-side.md
```

Wait for the drafts to appear before `--review`. In mock mode that takes a few seconds, in live mode up to about a minute. `send_fixtures.py --review` reports any review page that isn't there yet.

To check idempotency, send the same batch again and compare:

```powershell
python scripts/send_fixtures.py --replay
python scripts/collect_results.py --replay   # writes output/results-replay.md
```

Every inquiry should come back as `duplicate_submission`, and the number of demo Leads and Contacts should stay the same.

## 6. Live mode

Run everything in mock mode first. To use OpenAI, set `LLM_MODE=live` in `.env`, recreate the container, and switch back afterwards:

```powershell
docker compose up -d
docker compose exec -T n8n printenv LLM_MODE
# reset, send, review, collect as above
```

A full run makes about ten small OpenAI calls (five classifications, four drafts, and T7's failing call with its retries).

## Offline checks

```powershell
node --test "n8n-src/code/*.test.js" "n8n-src/*.test.mjs"
python -m unittest discover tests_scripts
```

On Windows, pass the test files as a glob; giving `node --test` a folder fails.

## Troubleshooting

- **`invalid_client` or `invalid_grant` when getting a token:** check `SF_INSTANCE_URL` (the My Domain URL, not the Lightning URL), the Consumer Key and Secret, and that Client Credentials Flow is enabled in both the OAuth settings and the policies, with a Run As user. A new app can take a few minutes.
- **`No such column 'Lead_Tier__c'` or `INVALID_FIELD`:** the fields don't exist yet, or the Run As user can't see them. Run `python scripts/salesforce_setup.py` again; it adds missing field permissions and the assignment.
- **`Salesforce lookup failed` in Slack:** the lookup stops on any Salesforce error on purpose, so a broken query never looks like "no match". The alert includes the Salesforce error code.
- **429 `insufficient_quota` from OpenAI:** the account behind the key has no credit. The leads are still saved as Needs review with an alert, so nothing is lost, but there's no classification until you add credit.
- **Webhook 404 right after a restart:** wait a few seconds and retry.
- **Review page says "Review not accepted":** the reviewer name is empty or no decision was picked. Go back, fix it and submit again; nothing was sent.
- **Credential decryption error:** `N8N_ENCRYPTION_KEY` changed. Put the original back.
- **An email isn't picked up:** the trigger only reads unread mail in INBOX. In demo mode, senders outside `example.com` / `example.org` are skipped on purpose.
