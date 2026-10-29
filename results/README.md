# Live results

Each file is the output of a `collect_results.py` run after a live run with OpenAI (`gpt-4.1-mini`). Mock runs aren't kept here.

| File | Run | Score |
|---|---|---|
| `salesforce-live-round-1.json` | This project, live run 1, 2026-10-30 | T1–T8 8/8, T9 passed |
| `hubspot-live-round-2.json` | The HubSpot version, live run 2, 2026-10-29 | T1–T8 8/8 (T9 doesn't exist there) |

The Salesforce version passed on its first live run. The HubSpot version got 4 of 8 on its first live run: a correct but long AI quote failed the word-for-word check. That check was changed to shorten long quotes, and the same fix was already in place here.

`python scripts/compare_results.py --salesforce results/salesforce-live-round-1.json` puts the two side by side.
