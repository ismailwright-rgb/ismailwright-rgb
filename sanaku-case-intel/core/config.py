"""Per-client configuration loader.

Every firm-specific value (branding, tier, storage paths, model choices,
license location) lives in one config file — config/client.json — never
hardcoded into application code. Onboarding a new firm means dropping in a
new config, not editing code (guardrail #3 in the mission brief).

The Ollama base URL is deliberately NOT a config field here: it isn't part
of the client-config spec, and Ollama itself already respects an
OLLAMA_HOST env var for this. See core/embed.py / core/generate.py for the
constant + env var fallback.
"""
from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "client.json"


class Colors(BaseModel):
    primary: str
    secondary: str
    accent: str


class ClientConfig(BaseModel):
    firm_name: str
    logo_path: str
    colors: Colors
    tier: str
    data_root: str
    gen_model: str
    embed_model: str
    license_path: str


def load_config(path: Path | None = None) -> ClientConfig:
    """Load and validate the active client config.

    Raises FileNotFoundError with an actionable message rather than a bare
    stack trace — this is the first thing a firm's setup script runs, and a
    missing config/client.json (not yet copied from the example) is the
    single most likely failure on a fresh machine.
    """
    path = path or DEFAULT_CONFIG_PATH
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. Copy config/client.example.json to "
            f"config/client.json and fill in this firm's values."
        )
    return ClientConfig.model_validate_json(path.read_text())
