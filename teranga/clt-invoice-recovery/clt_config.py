"""Load .env config for the CLT invoice recovery pipeline.

Minimal hand-rolled .env parser so the pipeline has no dependency beyond
the Google client libraries.
"""

import os
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV_PATH = HERE / ".env"


def _load_env_file(path: Path) -> dict:
    values = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip().strip('"').strip("'")
    return values


_FILE_ENV = _load_env_file(ENV_PATH)


def get(key: str, default: str = "") -> str:
    """Real environment wins over .env file."""
    return os.environ.get(key, _FILE_ENV.get(key, default))


def require(key: str) -> str:
    val = get(key)
    if not val:
        sys.exit(
            f"Missing required config {key!r}. Copy .env.example to .env in "
            f"{HERE} and fill it in."
        )
    return val


def get_list(key: str, default: str = "") -> list[str]:
    return [v.strip() for v in get(key, default).split(",") if v.strip()]


def get_date(key: str) -> date:
    val = require(key)
    try:
        return date.fromisoformat(val)
    except ValueError:
        sys.exit(f"Config {key}={val!r} is not a YYYY-MM-DD date.")


def outage_window() -> tuple[date, date]:
    start, end = get_date("OUTAGE_START"), get_date("OUTAGE_END")
    if start >= end:
        sys.exit(f"OUTAGE_START {start} is not before OUTAGE_END {end}.")
    return start, end
