"""Import credentials and generated workflows into the local n8n, then publish them.

Secrets go from .env into a temp file, are copied into the container for the import
and deleted on both sides right after. Nothing secret is printed.
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

try:
    from .envfile import ROOT, load_env, mask, require
except ImportError:
    from envfile import ROOT, load_env, mask, require

WORKFLOW_IDS = ["wfErrorHandler", "wfProcessInquiry", "wfReviewPage", "wfFormIntake", "wfEmailIntake"]


def credentials(values):
    gmail_password = require(values, "GMAIL_APP_PASSWORD").replace(" ", "")
    gmail = require(values, "GMAIL_ADDRESS")
    return [
        # n8n fetches the token itself on first use and again when Salesforce answers 401.
        {"id": "salesforceOAuthCred01", "name": "Salesforce (client credentials)", "type": "oAuth2Api",
         "data": {"grantType": "clientCredentials", "accessTokenUrl": f"{require(values, 'SF_INSTANCE_URL').rstrip('/')}/services/oauth2/token",
                  "clientId": require(values, "SF_CLIENT_ID"), "clientSecret": require(values, "SF_CLIENT_SECRET"),
                  "scope": "", "authentication": "body"}},
        {"id": "openAiCred01", "name": "OpenAI", "type": "httpHeaderAuth",
         "data": {"name": "Authorization", "value": f"Bearer {require(values, 'OPENAI_API_KEY')}"}},
        {"id": "gmailImapCred01", "name": "Gmail IMAP (demo inbox)", "type": "imap",
         "data": {"user": gmail, "password": gmail_password, "host": "imap.gmail.com", "port": 993, "secure": True, "allowUnauthorizedCerts": False}},
        {"id": "gmailSmtpCred01", "name": "Gmail SMTP (demo inbox)", "type": "smtp",
         "data": {"user": gmail, "password": gmail_password, "host": "smtp.gmail.com", "port": 465, "secure": True, "disableStartTls": False, "hostName": ""}},
    ]


def run(command, values):
    result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise SystemExit(f"Command failed: {' '.join(command[:4])}…\n{mask(result.stderr[-800:], values)}")
    return result.stdout


def import_credentials(values):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
        local_path = Path(handle.name)
        json.dump(credentials(values), handle)
    container_path = "/tmp/lead-intake-credentials.json"
    try:
        run(["docker", "compose", "cp", str(local_path), f"n8n:{container_path}"], values)
        run(["docker", "compose", "exec", "-T", "n8n", "n8n", "import:credentials", "--input", container_path], values)
    finally:
        local_path.unlink(missing_ok=True)
        subprocess.run(["docker", "compose", "exec", "-T", "-u", "root", "n8n", "rm", "-f", container_path], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-credentials", action="store_true", help="only re-import and publish workflows")
    parser.add_argument("--no-publish", action="store_true")
    args = parser.parse_args()
    values = load_env()
    if not args.skip_credentials:
        import_credentials(values)
        print("Imported 4 credentials.")
    run(["docker", "compose", "exec", "-T", "n8n", "n8n", "import:workflow", "--separate", "--input=/files/workflows/"], values)
    print(f"Imported {len(WORKFLOW_IDS)} workflows.")
    if args.no_publish:
        return
    for workflow_id in WORKFLOW_IDS:
        run(["docker", "compose", "exec", "-T", "n8n", "n8n", "publish:workflow", f"--id={workflow_id}"], values)
    run(["docker", "compose", "restart", "n8n"], values)
    print("Published all workflows and restarted n8n (webhooks take a few seconds to register).")


if __name__ == "__main__":
    main()
