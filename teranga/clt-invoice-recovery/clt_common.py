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

# Never allow these mailboxes even if someone edits .env carelessly.
KNOWN_WRONG_MAILBOX_HINTS = ("brookhaven", "atl", "atlanta")


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
