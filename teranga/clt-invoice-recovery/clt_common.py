"""Shared constants/helpers with no Google-library dependencies, so the
IMAP + CSV (offline) path runs without installing the OAuth stack."""

import re
from datetime import timedelta
from pathlib import Path

import clt_config as config

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "clt_invoices"

# Attachments we treat as potential invoices. ATL lesson: in June, 3 of 6
# hookah invoices were phone screenshots — images are first-class citizens.
KEEP_EXTENSIONS = {
    ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".tif", ".tiff", ".webp",
    ".heic", ".bmp",
}

def wrong_mailbox_hints() -> tuple[str, ...]:
    """Substrings that must never appear in the authenticated mailbox.

    Belt-and-braces on top of the exact-address check; configure per
    location profile (e.g. CLT blocks 'atl'/'brookhaven', but the Afro
    District ATL profile must NOT block 'atl' — its own address
    contains it).
    """
    return tuple(h.lower() for h in config.get_list("WRONG_MAILBOX_HINTS"))


# Backwards-compatible alias for existing imports.
KNOWN_WRONG_MAILBOX_HINTS = wrong_mailbox_hints()


def default_query() -> str:
    vendors = config.get_list("PRIORITY_VENDORS")
    start, end = config.outage_window()
    # Pad the window: invoices for outage-period service often arrive after
    # the outage ends. classify.py enforces the real window on invoice DATE.
    after = start - timedelta(days=7)
    before = end + timedelta(days=21)
    vendor_clause = " OR ".join(f'"{v}"' for v in vendors)
    return (
        f"({vendor_clause}) has:attachment "
        f"after:{after:%Y/%m/%d} before:{before:%Y/%m/%d}"
    )


def safe_filename(name: str) -> str:
    return re.sub(r"[^\w.\- ]+", "_", name).strip() or "unnamed"
