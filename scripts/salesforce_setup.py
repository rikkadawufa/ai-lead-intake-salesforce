"""Create the lead intake fields, a permission set for them, and the T9 demo Contact (safe to rerun)."""
import argparse

try:
    from .demo_common import load_seed
    from .envfile import load_env, require
    from .salesforce_client import Salesforce, SalesforceError, soql_string
except ImportError:
    from demo_common import load_seed
    from envfile import load_env, require
    from salesforce_client import Salesforce, SalesforceError, soql_string

PERMISSION_SET = ("Lead_Intake_Demo", "Lead Intake Demo")
TIERS = ["qualified", "needs_review", "not_qualified"]
TOPICS = ["regular_cleaning", "deep_cleaning", "quote_request", "complaint", "job_application", "sales_pitch", "other"]
URGENCIES = ["high", "normal", "low"]
SOURCES = ["form", "email"]


def picklist(label, values):
    return {
        "label": label, "type": "Picklist",
        "valueSet": {"restricted": True, "valueSetDefinition": {"sorted": False, "value": [
            {"fullName": value, "label": value.replace("_", " ").capitalize(), "default": False} for value in values
        ]}},
    }


PERSON_FIELDS = [
    ("Lead_Tier__c", picklist("Lead Tier", TIERS)),
    ("Inquiry_Topic__c", picklist("Inquiry Topic", TOPICS)),
    ("Inquiry_Urgency__c", picklist("Inquiry Urgency", URGENCIES)),
    ("Inquiry_Source__c", picklist("Inquiry Source", SOURCES)),
    ("AI_Reason__c", {"label": "AI Reason", "type": "LongTextArea", "length": 32768, "visibleLines": 6}),
    ("Phone_E164__c", {"label": "Phone (E.164)", "type": "Text", "length": 16}),
]
TASK_FIELD = ("Inquiry_Source_ID__c", {"label": "Inquiry Source ID", "type": "Text", "length": 255, "externalId": True, "unique": True, "caseSensitive": True})

# (object used for describe and field permissions, metadata prefix, field name, metadata)
FIELDS = [(obj, obj, name, meta) for obj in ("Lead", "Contact") for name, meta in PERSON_FIELDS] + [("Task", "Activity", *TASK_FIELD)]


def plain_text(meta):
    return {key: value for key, value in meta.items() if key not in ("externalId", "unique", "caseSensitive")}


def check_api_version(client):
    versions = client.api_versions()
    if client.api_version.lstrip("v") not in versions:
        raise SystemExit(f"API version {client.api_version} is not available in this org; newest is v{versions[-1]}. Set SF_API_VERSION in .env.")


def create_fields(client, dry_run):
    existing = {obj: client.describe_fields(obj) for obj in ("Lead", "Contact", "Task")}
    created, skipped, notes = [], [], []
    for obj, prefix, name, meta in FIELDS:
        label = f"{obj}.{name}"
        if name in existing[obj]:
            skipped.append(label)
            continue
        if dry_run:
            created.append(label)
            continue
        try:
            client.create_custom_field(f"{prefix}.{name}", meta)
        except SalesforceError:
            if not meta.get("unique"):
                raise
            # Some orgs refuse unique/external ID on activity fields; duplicates are still caught by the lookup query.
            client.create_custom_field(f"{prefix}.{name}", plain_text(meta))
            notes.append(f"{label} created as a plain text field (unique/external ID refused)")
        created.append(label)
    return created, skipped, notes


def ensure_permission_set(client, dry_run):
    name, label = PERMISSION_SET
    found = client.query(f"SELECT Id FROM PermissionSet WHERE Name = {soql_string(name)}")
    if found:
        ps_id = found[0]["Id"]
    elif dry_run:
        return {"permission_set": "would create", "field_permissions": len(FIELDS), "assigned": "would assign"}
    else:
        ps_id = client.create("PermissionSet", {"Name": name, "Label": label})
    have = {item["Field"] for item in client.query(f"SELECT Field FROM FieldPermissions WHERE ParentId = {soql_string(ps_id)}")}
    added = 0
    for obj, _, field, _ in FIELDS:
        full = f"{obj}.{field}"
        if full in have:
            continue
        if not dry_run:
            client.create("FieldPermissions", {"ParentId": ps_id, "SobjectType": obj, "Field": full, "PermissionsRead": True, "PermissionsEdit": True})
        added += 1
    user_id = client.user_id()
    assigned = client.query(f"SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId = {soql_string(ps_id)} AND AssigneeId = {soql_string(user_id)}")
    if not assigned and not dry_run:
        client.create("PermissionSetAssignment", {"PermissionSetId": ps_id, "AssigneeId": user_id})
    return {"permission_set": ps_id, "field_permissions_added": added, "assigned": "already" if assigned else ("would assign" if dry_run else "now")}


def ensure_seed(client, dry_run, seed=None):
    """Create the existing customer that T9 writes in as (an Account and its Contact)."""
    seed = seed or load_seed()
    result = []
    for person in seed:
        found = client.query(f"SELECT Id FROM Contact WHERE Email = {soql_string(person['email'])}")
        if found:
            result.append(f"{person['email']}: exists")
            continue
        if dry_run:
            result.append(f"{person['email']}: would create")
            continue
        accounts = client.query(f"SELECT Id FROM Account WHERE Name = {soql_string(person['account'])}")
        account_id = accounts[0]["Id"] if accounts else client.create("Account", {"Name": person["account"]})
        client.create("Contact", {
            "AccountId": account_id, "FirstName": person["first_name"], "LastName": person["last_name"],
            "Email": person["email"], "Phone": person["phone"], "Phone_E164__c": person["phone"],
        })
        result.append(f"{person['email']}: created")
    return result


def setup(client, dry_run=False):
    check_api_version(client)
    created, skipped, notes = create_fields(client, dry_run)
    if dry_run and created:
        # Field permissions and the seed Contact need the fields to exist first.
        return {"would_create_fields": created, "skipped": skipped}
    result = {"created_fields": created, "skipped_fields": skipped, "notes": notes}
    result.update(ensure_permission_set(client, dry_run))
    result["seed"] = ensure_seed(client, dry_run)
    return result


def client_from_env(values=None):
    values = values or load_env()
    return Salesforce(require(values, "SF_INSTANCE_URL"), require(values, "SF_CLIENT_ID"), require(values, "SF_CLIENT_SECRET"), values.get("SF_API_VERSION"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    for key, value in setup(client_from_env(), dry_run=args.dry_run).items():
        print(f"{key}: {value}")


if __name__ == "__main__":
    main()
