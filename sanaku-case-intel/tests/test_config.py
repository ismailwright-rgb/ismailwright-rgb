"""core/config.py's load_config() only ever raised FileNotFoundError on
its own (a genuinely missing config/client.json). Real bug found live:
a config/client.json that *exists* but has invalid content - malformed
JSON, or content that doesn't match ClientConfig's schema - raises a
different exception entirely (json.JSONDecodeError or pydantic's
ValidationError, both ValueError subclasses), which api/main.py's
get_config() never caught, producing an unhandled 500 on every route
that depends on it (/theme, /cases, /ask, ...) with no indication why.
"""
from __future__ import annotations

import json

import pytest

from core.config import load_config


def test_load_config_raises_file_not_found_when_missing(tmp_path):
    missing = tmp_path / "client.json"
    with pytest.raises(FileNotFoundError):
        load_config(missing)


def test_load_config_raises_value_error_on_malformed_json(tmp_path):
    bad = tmp_path / "client.json"
    bad.write_text("{ this is not valid json")
    with pytest.raises(ValueError):
        load_config(bad)


def test_load_config_raises_value_error_on_schema_mismatch(tmp_path):
    # Valid JSON, but missing every field ClientConfig requires (firm_name,
    # colors, tier, data_root, gen_model, embed_model, license_path, ...).
    bad = tmp_path / "client.json"
    bad.write_text(json.dumps({"firm_name": "Only One Field LLP"}))
    with pytest.raises(ValueError):
        load_config(bad)
