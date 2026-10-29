import tempfile
import unittest
import urllib.parse
from pathlib import Path

from scripts.envfile import mask
from scripts.reset_demo import reset
from scripts.salesforce_client import Salesforce, SalesforceError, is_demo_email, is_demo_record, soql_string
from scripts.salesforce_setup import FIELDS, setup

TOKEN = (200, {"access_token": "00Dxx!secret-token", "instance_url": "https://demo.my.salesforce.com"})
SEED = [{"first_name": "Avery", "last_name": "Brooks", "email": "avery.brooks@example.com", "phone": "+15105550188", "account": "Brookside Veterinary (demo)"}]


class FakeTransport:
    """Routes (method, url fragment) to a list of responses; the last response repeats."""

    def __init__(self, routes):
        self.routes = {"token": [TOKEN], **routes}
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, body))
        if url.endswith("/services/oauth2/token"):
            return self._next("token")
        for key in self.routes:
            if key != "token" and method == key[0] and key[1] in urllib.parse.unquote_plus(url):
                return self._next(key)
        return 404, [{"errorCode": "NOT_FOUND", "message": "not found"}]

    def _next(self, key):
        responses = self.routes[key]
        return responses.pop(0) if len(responses) > 1 else responses[0]

    def posts(self, fragment):
        return [body for method, url, body in self.calls if method == "POST" and fragment in url]


def client(routes):
    transport = FakeTransport(routes)
    return Salesforce("https://demo.my.salesforce.com/", "client-id-123", "client-secret-456", transport=transport, sleep=lambda _: None), transport


def describe(names):
    return (200, {"fields": [{"name": name} for name in ["Id", "Email", *names]]})


class ClientTests(unittest.TestCase):
    def test_token_is_fetched_once_and_sent_as_bearer(self):
        sf, transport = client({("GET", "/oauth2/userinfo"): [(200, {"user_id": "005A"})]})
        self.assertEqual(sf.user_id(), "005A")
        self.assertEqual(sf.user_id(), "005A")
        token_calls = [url for _, url, _ in transport.calls if url.endswith("/oauth2/token")]
        self.assertEqual(len(token_calls), 1)
        body = urllib.parse.parse_qs(transport.calls[0][2].decode())
        self.assertEqual(body["grant_type"], ["client_credentials"])

    def test_expired_session_gets_a_new_token(self):
        sf, transport = client({("GET", "/oauth2/userinfo"): [(401, [{"errorCode": "INVALID_SESSION_ID"}]), (200, {"user_id": "005A"})]})
        self.assertEqual(sf.user_id(), "005A")
        self.assertEqual(sum(url.endswith("/oauth2/token") for _, url, _ in transport.calls), 2)

    def test_retries_rate_limit(self):
        sf, _ = client({("GET", "/oauth2/userinfo"): [(503, {}), (200, {"user_id": "005A"})]})
        self.assertEqual(sf.user_id(), "005A")

    def test_errors_never_contain_secrets(self):
        sf, _ = client({("GET", "/oauth2/userinfo"): [(400, [{"errorCode": "X", "message": "bad 00Dxx!secret-token client-secret-456"}])]})
        with self.assertRaises(SalesforceError) as caught:
            sf.user_id()
        self.assertNotIn("secret-token", str(caught.exception))
        self.assertNotIn("client-secret-456", str(caught.exception))

    def test_bad_credentials_explain_what_to_check(self):
        transport = FakeTransport({})
        transport.routes["token"] = [(400, {"error": "invalid_client", "error_description": "invalid client credentials"})]
        sf = Salesforce("https://demo.my.salesforce.com", "id", "secret", transport=transport, sleep=lambda _: None)
        with self.assertRaises(SalesforceError) as caught:
            sf.user_id()
        self.assertIn("Run As user", str(caught.exception))

    def test_query_follows_next_records_url(self):
        sf, _ = client({
            ("GET", "/query?q="): [(200, {"done": False, "records": [{"Id": "1"}], "nextRecordsUrl": "/services/data/v63.0/query/01g-2000"})],
            ("GET", "/query/01g-2000"): [(200, {"done": True, "records": [{"Id": "2"}]})],
        })
        self.assertEqual([item["Id"] for item in sf.query("SELECT Id FROM Lead")], ["1", "2"])

    def test_demo_people_keeps_only_demo_domains(self):
        sf, _ = client({
            ("GET", "FROM Lead"): [(200, {"done": True, "records": [{"Id": "L1", "Email": "a@example.com"}, {"Id": "L2", "Email": "x@company.com"}]})],
            ("GET", "FROM Contact"): [(200, {"done": True, "records": [{"Id": "C1", "Email": "b@example.org"}]})],
        })
        self.assertEqual([(item["type"], item["Id"]) for item in sf.demo_people()], [("Lead", "L1"), ("Contact", "C1")])

    def test_soql_string_escapes_quotes_and_backslashes(self):
        self.assertEqual(soql_string("o'brien\\x@example.com"), "'o\\'brien\\\\x@example.com'")

    def test_demo_email_check(self):
        self.assertTrue(is_demo_email("Dana@Example.com"))
        self.assertFalse(is_demo_email("dana@example.co"))

    def test_phone_only_records_count_as_demo_only_in_the_fictional_range(self):
        self.assertTrue(is_demo_record({"Email": None, "Phone_E164__c": "+15105550177"}))
        self.assertFalse(is_demo_record({"Email": None, "Phone_E164__c": "+15105551234"}))
        self.assertFalse(is_demo_record({"Email": "real@company.com", "Phone_E164__c": "+15105550177"}))

    def test_mask_replaces_salesforce_secret(self):
        self.assertEqual(mask("secret is abc123", {"SF_CLIENT_SECRET": "abc123"}), "secret is ***")


def setup_routes(lead=(), contact=(), task=(), permission_set=None, assigned=False, seed_exists=False, field_errors=None):
    return {
        ("GET", "/sobjects/Lead/describe"): [describe(lead)],
        ("GET", "/sobjects/Contact/describe"): [describe(contact)],
        ("GET", "/sobjects/Task/describe"): [describe(task)],
        ("POST", "/tooling/sobjects/CustomField"): field_errors or [(201, {"id": "00N1", "success": True})],
        ("GET", "FROM PermissionSet "): [(200, {"done": True, "records": [{"Id": permission_set}] if permission_set else []})],
        ("POST", "/sobjects/PermissionSet"): [(201, {"id": "0PS1"})],
        ("GET", "FROM FieldPermissions"): [(200, {"done": True, "records": []})],
        ("POST", "/sobjects/FieldPermissions"): [(201, {"id": "01k1"})],
        ("GET", "/oauth2/userinfo"): [(200, {"user_id": "005A"})],
        ("GET", "FROM PermissionSetAssignment"): [(200, {"done": True, "records": [{"Id": "0Pa1"}] if assigned else []})],
        ("POST", "/sobjects/PermissionSetAssignment"): [(201, {"id": "0Pa1"})],
        ("GET", "FROM Contact WHERE Email"): [(200, {"done": True, "records": [{"Id": "003S"}] if seed_exists else []})],
        ("GET", "FROM Account WHERE Name"): [(200, {"done": True, "records": []})],
        ("POST", "/sobjects/Account"): [(201, {"id": "001A"})],
        ("POST", "/sobjects/Contact"): [(201, {"id": "003S"})],
        # Last, so the more specific /services/data/... routes above win.
        ("GET", "/services/data"): [(200, [{"version": "62.0"}, {"version": "63.0"}])],
    }


ALL_PERSON = [name for obj, _, name, _ in FIELDS if obj == "Lead"]


class SetupTests(unittest.TestCase):
    def test_fresh_org_gets_every_field_permission_and_the_seed_contact(self):
        sf, transport = client(setup_routes())
        result = setup(sf)
        self.assertEqual(len(result["created_fields"]), 13)
        self.assertEqual(len(transport.posts("/sobjects/FieldPermissions")), 13)
        self.assertEqual(len(transport.posts("/sobjects/PermissionSetAssignment")), 1)
        self.assertEqual(transport.posts("/sobjects/Contact")[0]["Email"], "avery.brooks@example.com")
        task_field = [body for body in transport.posts("/tooling/sobjects/CustomField") if body["FullName"] == "Activity.Inquiry_Source_ID__c"][0]
        self.assertTrue(task_field["Metadata"]["unique"])

    def test_rerun_skips_everything(self):
        sf, transport = client(setup_routes(lead=ALL_PERSON, contact=ALL_PERSON, task=["Inquiry_Source_ID__c"], permission_set="0PS1", assigned=True, seed_exists=True))
        transport.routes[("GET", "FROM FieldPermissions")] = [(200, {"done": True, "records": [{"Field": f"{obj}.{name}"} for obj, _, name, _ in FIELDS]})]
        result = setup(sf)
        self.assertEqual(result["created_fields"], [])
        self.assertEqual(result["field_permissions_added"], 0)
        self.assertEqual(result["assigned"], "already")
        self.assertFalse(any(method == "POST" and "/oauth2/token" not in url for method, url, _ in transport.calls))

    def test_unique_refused_falls_back_to_plain_text(self):
        routes = setup_routes(lead=ALL_PERSON, contact=ALL_PERSON)
        routes[("POST", "/tooling/sobjects/CustomField")] = [(400, [{"errorCode": "FIELD_INTEGRITY_EXCEPTION", "message": "unique not allowed"}]), (201, {"id": "00N9"})]
        sf, transport = client(routes)
        result = setup(sf)
        retry = transport.posts("/tooling/sobjects/CustomField")[-1]["Metadata"]
        self.assertNotIn("unique", retry)
        self.assertIn("plain text", result["notes"][0])

    def test_dry_run_creates_nothing(self):
        sf, transport = client(setup_routes())
        result = setup(sf, dry_run=True)
        self.assertEqual(len(result["would_create_fields"]), 13)
        self.assertFalse(any(method in ("POST", "PATCH", "DELETE") and "/oauth2/token" not in url for method, url, _ in transport.calls))

    def test_unknown_api_version_stops(self):
        routes = setup_routes()
        routes[("GET", "/services/data")] = [(200, [{"version": "61.0"}])]
        sf, _ = client(routes)
        with self.assertRaises(SystemExit):
            setup(sf)


class ResetTests(unittest.TestCase):
    def routes(self):
        return {
            ("GET", "FROM Lead"): [(200, {"done": True, "records": [{"Id": "00Q1", "Email": "dana.whitfield@example.com"}, {"Id": "00Q2", "Email": "real@customer.com"}]})],
            ("GET", "FROM Contact WHERE Email LIKE"): [(200, {"done": True, "records": [{"Id": "003S", "Email": "avery.brooks@example.com"}]})],
            ("GET", "FROM Task"): [(200, {"done": True, "records": [{"Id": "00T1", "WhoId": "00Q1"}, {"Id": "00T2", "WhoId": "003S"}]})],
            ("GET", "FROM Account WHERE Name"): [(200, {"done": True, "records": [{"Id": "001A", "Name": "Brookside Veterinary (demo)"}]})],
            ("DELETE", "/sobjects/"): [(204, {})],
            ("GET", "FROM Contact WHERE Email ="): [(200, {"done": True, "records": []})],
            ("POST", "/sobjects/Account"): [(201, {"id": "001B"})],
            ("POST", "/sobjects/Contact"): [(201, {"id": "003T"})],
        }

    def test_dry_run_deletes_nothing_and_skips_real_addresses(self):
        sf, transport = client(self.routes())
        with tempfile.TemporaryDirectory() as folder:
            result = reset(sf, apply=False, output=Path(folder), seed=SEED)
        self.assertEqual([item["email"] for item in result["people"]], ["dana.whitfield@example.com", "avery.brooks@example.com"])
        self.assertFalse(any(method == "DELETE" for method, _, _ in transport.calls))

    def test_apply_deletes_demo_records_then_reseeds(self):
        sf, transport = client(self.routes())
        with tempfile.TemporaryDirectory() as folder:
            result = reset(sf, apply=True, output=Path(folder), seed=SEED)
        deleted = [url.rsplit("/sobjects/", 1)[1] for method, url, _ in transport.calls if method == "DELETE"]
        self.assertEqual(deleted, ["Task/00T1", "Task/00T2", "Lead/00Q1", "Contact/003S", "Account/001A"])
        self.assertEqual(result["reseeded"], ["avery.brooks@example.com: created"])


if __name__ == "__main__":
    unittest.main()
