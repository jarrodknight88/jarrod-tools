"""Step 1 — authenticate to the CHARLOTTE Gmail account. The gate.

Run directly for the one-time consent flow:

    python3 clt_auth.py

Requires credentials.json (OAuth Desktop-app client from a Google Cloud
project with the Gmail API, Sheets API, and Drive API enabled) in this
directory. Caches the token as token_clt.json.

Every other script in the pipeline gets its API clients from
verified_services(), which hard-fails unless the authenticated mailbox
matches CLT_GMAIL_ADDRESS in .env. This is the #1 failure mode from the
ATL run: sweeping the wrong mailbox. Do not weaken this check.
"""

import sys
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

import clt_config as config

HERE = Path(__file__).resolve().parent
CREDENTIALS_PATH = HERE / "credentials.json"
TOKEN_PATH = HERE / "token_clt.json"

# gmail.readonly: fetch invoice attachments
# spreadsheets: read/append the CLT recon
# drive.file: upload archived PDFs to the CLT archive folder
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
]

# Never allow these mailboxes even if someone edits .env carelessly.
KNOWN_WRONG_MAILBOX_HINTS = ("brookhaven", "atl", "atlanta")


def _credentials() -> Credentials:
    creds = None
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    else:
        if not CREDENTIALS_PATH.exists():
            sys.exit(
                f"credentials.json not found at {CREDENTIALS_PATH}.\n"
                "Create an OAuth Desktop-app client in a Google Cloud project "
                "with the Gmail, Sheets, and Drive APIs enabled, download the "
                "JSON, and save it there. Then re-run: python3 clt_auth.py\n"
                "IMPORTANT: complete the consent screen logged in as the "
                "CHARLOTTE account, not Brookhaven/ATL."
            )
        flow = InstalledAppFlow.from_client_secrets_file(
            str(CREDENTIALS_PATH), SCOPES
        )
        creds = flow.run_local_server(port=0)
    TOKEN_PATH.write_text(creds.to_json())
    return creds


def verified_services():
    """Return (gmail, sheets, drive) clients, gated on the mailbox check."""
    expected = config.require("CLT_GMAIL_ADDRESS").lower()
    creds = _credentials()
    gmail = build("gmail", "v1", credentials=creds)

    profile = gmail.users().getProfile(userId="me").execute()
    actual = profile["emailAddress"].lower()

    if actual != expected:
        sys.exit(
            f"WRONG MAILBOX — authenticated as {actual!r} but .env expects "
            f"CLT_GMAIL_ADDRESS={expected!r}.\n"
            f"Delete {TOKEN_PATH.name} and redo the consent flow logged in as "
            "the Charlotte account. Nothing was fetched or written."
        )
    if any(hint in actual for hint in KNOWN_WRONG_MAILBOX_HINTS):
        sys.exit(
            f"REFUSING to run: authenticated mailbox {actual!r} looks like an "
            "ATL/Brookhaven account. Fix CLT_GMAIL_ADDRESS and the token."
        )

    sheets = build("sheets", "v4", credentials=creds)
    drive = build("drive", "v3", credentials=creds)
    return gmail, sheets, drive


def main():
    gmail, _, _ = verified_services()
    profile = gmail.users().getProfile(userId="me").execute()
    print("Authenticated mailbox :", profile["emailAddress"])
    print("Total messages        :", profile.get("messagesTotal", "?"))
    print()
    print("^ CONFIRM this is the Charlotte account before running anything else.")
    print(f"Token cached at {TOKEN_PATH}")


if __name__ == "__main__":
    main()
