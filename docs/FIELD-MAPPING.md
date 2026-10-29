# Field mapping

How an inquiry from the website form or the inbox lands in Salesforce. The code is in `n8n-src/code/match.js` (Lead and Contact fields) and `n8n-src/code/records.js` (Tasks).

## 1. Inquiry fields

Both sources are first turned into one shape (`n8n-src/code/normalize.js`).

| Inquiry field | From the form | From an email |
|---|---|---|
| `name` | `name` | Reply-To display name, else From |
| `email` | `email`, lowercased | Reply-To address, else From, lowercased |
| `phone` | `phone`, converted to E.164 (`+1…` by default) | first phone number found in the body, E.164 |
| `company` | `company` | not set |
| `subject` | not set | email subject |
| `message` | `message` | body without quoted replies or the signature |
| `source` | `form` | `email` |
| `source_id` | `form:<submission_id>` | `email:<Message-ID>` |

## 2. Finding the record

One Composite request looks for, in this order:

1. A Task whose `Inquiry_Source_ID__c` equals `source_id`. If one exists, the inquiry was already handled and nothing else happens.
2. A Contact with the same email.
3. A Lead (not converted) with the same email.
4. A Contact with the same `Phone_E164__c`.
5. A Lead (not converted) with the same `Phone_E164__c`.
6. A phone search (`FIND {…} IN PHONE FIELDS`) for numbers typed in a different format. Search results can lag a few seconds behind new records.

A match is updated. No match creates a Lead. A Contact is never created and a Lead is never converted; that stays with the sales team.

## 3. Lead and Contact fields

| Salesforce field | New Lead | Matched Lead or Contact |
|---|---|---|
| `FirstName` | first word of `name`, only when there is also a last name | filled only if empty |
| `LastName` (required on Lead) | rest of `name`; else the single name; else the part of the email before `@`; else `(unknown)` | not changed |
| `Company` (Lead only, required) | `company`, else `[not provided]` | filled if empty or `[not provided]` |
| `Email` | `email` | filled only if empty |
| `Phone` | `phone` (E.164) | filled only if empty |
| `Phone_E164__c` | `phone` | filled only if empty |
| `LeadSource` | `Web` for form inquiries | not changed |
| `Lead_Tier__c` | AI tier | AI tier, but a record that is already `qualified` stays `qualified` |
| `Inquiry_Topic__c` | AI topic | latest AI topic |
| `Inquiry_Urgency__c` | AI urgency | latest AI urgency |
| `Inquiry_Source__c` | `form` or `email` | latest source |
| `AI_Reason__c` | AI reason plus the quoted sentence from the message | latest reason |

When the AI call fails, the tier is `needs_review`, the topic `other`, the urgency `normal`, and the reason says the classification failed.

If a Salesforce duplicate rule blocks a new Lead, the record it points to is read and updated instead.

## 4. Tasks

| Task | Fields |
|---|---|
| One per inquiry | `WhoId` = the Lead or Contact; `Subject` = `Inquiry via <source>: <subject or start of message>`; `Description` = received time, subject, the full message and the AI line; `Status` = `Completed`; `ActivityDate` = date received; `Inquiry_Source_ID__c` = `source_id` |
| One per review decision | `WhoId` as above; `Subject` = `AI reply approved by <name>`, `AI reply rejected by <name>` or `AI reply review timed out`; `Description` = whether the draft was edited, who decided, when, where it was sent, and the reply text that went out |

## 5. Custom fields created by `scripts/salesforce_setup.py`

| Object | Field | Type |
|---|---|---|
| Lead, Contact | `Lead_Tier__c` | Picklist: `qualified`, `needs_review`, `not_qualified` |
| Lead, Contact | `Inquiry_Topic__c` | Picklist: `regular_cleaning`, `deep_cleaning`, `quote_request`, `complaint`, `job_application`, `sales_pitch`, `other` |
| Lead, Contact | `Inquiry_Urgency__c` | Picklist: `high`, `normal`, `low` |
| Lead, Contact | `Inquiry_Source__c` | Picklist: `form`, `email` |
| Lead, Contact | `AI_Reason__c` | Long text area |
| Lead, Contact | `Phone_E164__c` | Text (16) |
| Task | `Inquiry_Source_ID__c` | Text (255) |

The picklist values must match the enums in `prompts/qualify.md`. The script also creates the permission set `Lead_Intake_Demo` with read and edit access to these fields and assigns it to the integration user.
