import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIXES = ("SF_", "GMAIL_", "OPENAI_", "SLACK_", "LLM_", "N8N_", "GENERIC_", "REPLY_", "DEMO_")


def load_env(path=ROOT / ".env"):
    values = {}
    env_path = Path(path)
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            values[key.strip()] = value.strip()
    for key, value in os.environ.items():
        if key in values or key.startswith(PREFIXES):
            values[key] = value
    return values


def require(values, name):
    if not values.get(name):
        raise SystemExit(f"Missing {name} in .env")
    return values[name]


def mask(text, values):
    """Replace every secret value that appears in text with ***."""
    text = str(text)
    for name in ("SF_CLIENT_SECRET", "SF_CLIENT_ID", "OPENAI_API_KEY", "GMAIL_APP_PASSWORD", "SLACK_WEBHOOK_URL"):
        secret = values.get(name)
        if secret:
            text = text.replace(secret, "***").replace(secret.replace(" ", ""), "***")
    return text
