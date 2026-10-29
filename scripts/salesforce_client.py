"""Small Salesforce REST/Tooling client (stdlib only) shared by the demo scripts.

Auth is the OAuth 2.0 client credentials flow of an External Client App with a Run As user.
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_API_VERSION = "v63.0"
DEMO_DOMAINS = ("@example.com", "@example.org")
PERSON_FIELDS = ["Id", "FirstName", "LastName", "Email", "Phone", "Phone_E164__c", "Lead_Tier__c", "AI_Reason__c"]
RETRY_STATUSES = (429, 500, 502, 503, 504)


class SalesforceError(Exception):
    def __init__(self, status, message):
        super().__init__(f"Salesforce API {status}: {message}")
        self.status = status


def urllib_transport(method, url, headers, body):
    if isinstance(body, (bytes, type(None))):
        data = body
    else:
        data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {"message": raw[:300]}


def is_demo_email(email):
    return bool(email) and email.lower().endswith(DEMO_DOMAINS)


def is_demo_phone(e164):
    """Fictional US range 555-0100 to 555-0199, used for phone-only demo inquiries."""
    value = str(e164 or "")
    return len(value) == 12 and value.startswith("+1") and value[5:10] == "55501" and value[2:].isdigit()


def is_demo_record(item):
    return is_demo_email(item.get("Email")) or (not item.get("Email") and is_demo_phone(item.get("Phone_E164__c")))


def soql_string(value):
    """Quote a value for a SOQL string literal."""
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def error_text(payload):
    if isinstance(payload, list):
        return "; ".join(f"{item.get('errorCode', '')}: {item.get('message', '')}".strip(": ") for item in payload if isinstance(item, dict))
    if isinstance(payload, dict):
        return payload.get("error_description") or payload.get("message") or payload.get("error") or json.dumps(payload)[:300]
    return str(payload)[:300]


class Salesforce:
    def __init__(self, instance_url, client_id, client_secret, api_version=DEFAULT_API_VERSION, transport=urllib_transport, sleep=time.sleep):
        self.instance_url = instance_url.rstrip("/")
        self.api_version = api_version or DEFAULT_API_VERSION
        self._client_id = client_id
        self._client_secret = client_secret
        self._transport = transport
        self._sleep = sleep
        self._token = None

    def _mask(self, text):
        text = str(text)
        for secret in (self._token, self._client_secret, self._client_id):
            if secret:
                text = text.replace(secret, "***")
        return text

    def _fetch_token(self):
        body = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": self._client_id, "client_secret": self._client_secret}).encode()
        status, payload = self._transport("POST", self.instance_url + "/services/oauth2/token", {"Content-Type": "application/x-www-form-urlencoded"}, body)
        if status != 200 or not payload.get("access_token"):
            hint = " (check SF_INSTANCE_URL, the Consumer Key/Secret, and that the client credentials flow has a Run As user)"
            raise SalesforceError(status, self._mask(error_text(payload)) + hint)
        self._token = payload["access_token"]

    def request(self, method, path, body=None, ok=(200, 201, 204), allow=()):
        if not self._token:
            self._fetch_token()
        refreshed = False
        attempt = 0
        while True:
            headers = {"Authorization": f"Bearer {self._token}", "Content-Type": "application/json", "Accept": "application/json"}
            status, payload = self._transport(method, self.instance_url + path, headers, body)
            if status == 401 and not refreshed:
                refreshed = True
                self._fetch_token()
                continue
            if status in RETRY_STATUSES and attempt < 2:
                attempt += 1
                self._sleep(2 * attempt)
                continue
            break
        if status in ok or status in allow:
            return status, payload
        message = error_text(payload)
        if status in (401, 403):
            message = f"{message} (check the Run As user and its permissions)"
        raise SalesforceError(status, self._mask(message))

    def data_path(self, path):
        return f"/services/data/{self.api_version}{path}"

    # Org
    def api_versions(self):
        return [item["version"] for item in self.request("GET", "/services/data")[1]]

    def user_id(self):
        return self.request("GET", "/services/oauth2/userinfo")[1]["user_id"]

    def describe_fields(self, sobject):
        payload = self.request("GET", self.data_path(f"/sobjects/{sobject}/describe"))[1]
        return {field["name"] for field in payload.get("fields", [])}

    # Records
    def query(self, soql):
        records = []
        path = self.data_path("/query?" + urllib.parse.urlencode({"q": soql}))
        while path:
            payload = self.request("GET", path)[1]
            records.extend(payload.get("records", []))
            path = None if payload.get("done", True) else payload.get("nextRecordsUrl")
        return records

    def create(self, sobject, fields):
        return self.request("POST", self.data_path(f"/sobjects/{sobject}"), fields)[1]["id"]

    def update(self, sobject, record_id, fields):
        self.request("PATCH", self.data_path(f"/sobjects/{sobject}/{record_id}"), fields)

    def delete(self, sobject, record_id):
        self.request("DELETE", self.data_path(f"/sobjects/{sobject}/{record_id}"), allow=(404,))

    # Tooling
    def create_custom_field(self, full_name, metadata):
        return self.request("POST", self.data_path("/tooling/sobjects/CustomField"), {"FullName": full_name, "Metadata": metadata})[1]

    # Demo records
    def demo_people(self):
        """Demo Leads (not converted) and Contacts: a reserved demo email domain, or no email and a fictional 555-01xx phone."""
        where = " OR ".join([*(f"Email LIKE {soql_string('%' + domain)}" for domain in DEMO_DOMAINS), "(Email = null AND Phone_E164__c LIKE '+1___55501__')"])
        fields = ", ".join(PERSON_FIELDS)
        leads = self.query(f"SELECT {fields}, Company FROM Lead WHERE IsConverted = false AND ({where})")
        contacts = self.query(f"SELECT {fields} FROM Contact WHERE {where}")
        people = [{**item, "type": "Lead"} for item in leads] + [{**item, "type": "Contact"} for item in contacts]
        return [item for item in people if is_demo_record(item)]

    def tasks_for(self, who_ids):
        if not who_ids:
            return []
        ids = ", ".join(soql_string(value) for value in who_ids)
        return self.query(f"SELECT Id, WhoId, Subject, Description, Inquiry_Source_ID__c FROM Task WHERE WhoId IN ({ids})")
