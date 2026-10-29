"""Remove demo Leads and Contacts (@example.com / @example.org, or no email and a 555-01xx phone) with their Tasks, clear local run output,
then recreate the T9 demo Contact.

Dry run by default; pass --apply to delete. Salesforce keeps deleted records in its Recycle Bin for 15 days.
"""
import argparse
import shutil

try:
    from .demo_common import OUTPUT, load_seed
    from .salesforce_client import is_demo_record, soql_string
    from .salesforce_setup import client_from_env, ensure_seed
except ImportError:
    from demo_common import OUTPUT, load_seed
    from salesforce_client import is_demo_record, soql_string
    from salesforce_setup import client_from_env, ensure_seed

LOCAL_DIRS = ("run-log", "review")


def reset(client, apply=False, output=OUTPUT, seed=None):
    seed = load_seed() if seed is None else seed
    people = [item for item in client.demo_people() if is_demo_record(item)]
    tasks = client.tasks_for([item["Id"] for item in people])
    accounts = []
    for name in sorted({person["account"] for person in seed}):
        accounts += client.query(f"SELECT Id, Name FROM Account WHERE Name = {soql_string(name)}")
    plan = [{"type": item["type"], "id": item["Id"], "email": item.get("Email") or item.get("Phone_E164__c"), "tasks": sum(task["WhoId"] == item["Id"] for task in tasks)} for item in people]
    if apply:
        for task in tasks:
            client.delete("Task", task["Id"])
        for item in people:
            client.delete(item["type"], item["Id"])
        for account in accounts:
            client.delete("Account", account["Id"])
    local = [name for name in LOCAL_DIRS if (output / name).exists()] + [path.name for path in output.glob("send-log-*.json")] + [path.name for path in output.glob("results*.*")]
    if apply:
        for name in LOCAL_DIRS:
            shutil.rmtree(output / name, ignore_errors=True)
        for pattern in ("send-log-*.json", "results*.*"):
            for path in output.glob(pattern):
                path.unlink()
    reseeded = ensure_seed(client, dry_run=not apply, seed=seed) if apply else []
    return {"applied": apply, "people": plan, "tasks": len(tasks), "accounts": [item["Name"] for item in accounts], "local": local, "reseeded": reseeded}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    result = reset(client_from_env(), apply=args.apply)
    verb = "Deleted" if result["applied"] else "Would delete"
    print(f"{verb} {len(result['people'])} demo Leads/Contacts, {result['tasks']} Tasks and accounts: {', '.join(result['accounts']) or 'none'}.")
    for item in result["people"]:
        print(f"  {item['type']} {item['email']} (id {item['id']}, {item['tasks']} tasks)")
    print(f"{'Cleared' if result['applied'] else 'Would clear'} local output: {', '.join(result['local']) or 'nothing'}")
    if result["reseeded"]:
        print(f"Recreated seed contacts: {', '.join(result['reseeded'])}")


if __name__ == "__main__":
    main()
