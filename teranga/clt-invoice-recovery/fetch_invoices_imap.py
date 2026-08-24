"""Alternative Step 3 — fetch via IMAP with a Gmail app password.

No Google Cloud project, OAuth client, or consent screen needed.
One-time setup on the CHARLOTTE account:
  1. Enable 2-Step Verification (myaccount.google.com/security).
  2. Create an app password: https://myaccount.google.com/apppasswords
  3. Put it in .env as CLT_APP_PASSWORD (spaces are fine, they're stripped).

    python3 fetch_invoices_imap.py [--query '...'] [--dry-run]

Uses Gmail's X-GM-RAW IMAP extension, so --query takes the exact same
Gmail search syntax as fetch_invoices.py. Writes the same clt_invoices/
files and manifest.csv, so parse/classify/load are unchanged.

The wrong-mailbox gate is inherent here: an IMAP login only succeeds
against the mailbox whose address and app password you supply.
"""

import argparse
import csv
import email
import imaplib
import sys
from email.header import decode_header
from email.utils import parsedate_to_datetime
from pathlib import Path

import clt_config as config
from clt_auth import KNOWN_WRONG_MAILBOX_HINTS
from fetch_invoices import KEEP_EXTENSIONS, OUT_DIR, default_query, safe_filename


def decode_hdr(value: str) -> str:
    return "".join(
        part.decode(enc or "utf-8", "replace") if isinstance(part, bytes) else part
        for part, enc in decode_header(value or "")
    )


def connect() -> imaplib.IMAP4_SSL:
    address = config.require("CLT_GMAIL_ADDRESS")
    password = config.require("CLT_APP_PASSWORD").replace(" ", "")
    if any(hint in address.lower() for hint in KNOWN_WRONG_MAILBOX_HINTS):
        sys.exit(
            f"REFUSING to run: CLT_GMAIL_ADDRESS {address!r} looks like an "
            "ATL/Brookhaven account."
        )
    conn = imaplib.IMAP4_SSL("imap.gmail.com")
    try:
        conn.login(address, password)
    except imaplib.IMAP4.error as e:
        sys.exit(
            f"IMAP login failed for {address}: {e}\n"
            "Check that 2-Step Verification is enabled on the Charlotte "
            "account and CLT_APP_PASSWORD is a current app password "
            "(https://myaccount.google.com/apppasswords)."
        )
    print(f"Authenticated mailbox : {address} (IMAP login is bound to this mailbox)\n")
    return conn


def search_uids(conn: imaplib.IMAP4_SSL, query: str) -> list[bytes]:
    typ, _ = conn.select('"[Gmail]/All Mail"', readonly=True)
    if typ != "OK":
        sys.exit("Could not open [Gmail]/All Mail over IMAP.")
    # X-GM-RAW runs a native Gmail query. Send it as an IMAP literal so
    # embedded quotes (multi-word vendor names) survive intact.
    try:
        conn.literal = query.encode("utf-8")
        typ, data = conn.uid("SEARCH", "CHARSET", "UTF-8", "X-GM-RAW")
    except imaplib.IMAP4.error:
        escaped = query.replace('"', '\\"')
        typ, data = conn.uid("SEARCH", "X-GM-RAW", f'"{escaped}"')
    if typ != "OK":
        sys.exit(f"IMAP search failed: {data}")
    return data[0].split() if data and data[0] else []


def fetch(conn: imaplib.IMAP4_SSL, query: str, dry_run: bool) -> None:
    OUT_DIR.mkdir(exist_ok=True)
    print(f"Gmail query: {query}\n")

    uids = search_uids(conn, query)
    print(f"{len(uids)} matching messages")

    rows, skipped = [], []
    for uid in uids:
        typ, msg_data = conn.uid("FETCH", uid, "(RFC822)")
        if typ != "OK" or not msg_data or msg_data[0] is None:
            skipped.append(("?", "?", f"uid {uid.decode()}", "fetch failed"))
            continue
        msg = email.message_from_bytes(msg_data[0][1])
        sender = decode_hdr(msg.get("From", ""))
        subject = decode_hdr(msg.get("Subject", ""))
        message_id = (msg.get("Message-ID") or f"uid-{uid.decode()}").strip("<> ")
        try:
            msg_date = parsedate_to_datetime(msg["Date"]).strftime("%Y-%m-%d")
        except (TypeError, ValueError):
            msg_date = "unknown-date"

        for part in msg.walk():
            filename = decode_hdr(part.get_filename() or "")
            if not filename:
                continue
            ext = Path(filename).suffix.lower()
            if ext not in KEEP_EXTENSIONS:
                skipped.append((msg_date, sender, filename, "extension"))
                continue

            out_name = f"{msg_date}_{uid.decode()}_{safe_filename(filename)}"
            if dry_run:
                print(f"  would fetch: {out_name}  ({sender} — {subject})")
            else:
                payload = part.get_payload(decode=True)
                if not payload:
                    skipped.append((msg_date, sender, filename, "empty payload"))
                    continue
                (OUT_DIR / out_name).write_bytes(payload)
                print(f"  fetched: {out_name}")

            rows.append({
                "file": out_name,
                "message_id": message_id,
                "email_date": msg_date,
                "from": sender,
                "subject": subject,
            })

    if not dry_run:
        with (OUT_DIR / "manifest.csv").open("w", newline="") as f:
            writer = csv.DictWriter(
                f, fieldnames=["file", "message_id", "email_date", "from", "subject"]
            )
            writer.writeheader()
            writer.writerows(rows)

    print(f"\n{len(rows)} attachments {'matched' if dry_run else 'downloaded'}")
    if skipped:
        print(f"{len(skipped)} attachments skipped:")
        for msg_date, sender, filename, reason in skipped:
            print(f"  {msg_date}  {filename!r}  from {sender}  [{reason}]")
    if not dry_run:
        print(f"Manifest: {OUT_DIR / 'manifest.csv'}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--query", help="Gmail search query (default: built from .env)")
    ap.add_argument("--dry-run", action="store_true", help="list matches only")
    args = ap.parse_args()

    conn = connect()
    try:
        fetch(conn, args.query or default_query(), args.dry_run)
    finally:
        conn.logout()


if __name__ == "__main__":
    main()
