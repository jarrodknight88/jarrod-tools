"""Step 3 — fetch invoice attachments from the CLT Gmail account.

    python3 fetch_invoices.py                  # default query from .env
    python3 fetch_invoices.py --query '...'    # explicit Gmail query
    python3 fetch_invoices.py --dry-run        # list matches, download nothing

Downloads every PDF and image attachment to ./clt_invoices/ by pulling
bytes through the Gmail API (attachments.get) — no short-lived hydrate
URLs. Writes clt_invoices/manifest.csv mapping each file back to its
message (sender, subject, date, message id) for provenance; parse and
classify use the manifest for vendor hints and entity checks.
"""

import argparse
import base64
import csv
from datetime import datetime
from pathlib import Path

from clt_auth import verified_services
from clt_common import KEEP_EXTENSIONS, OUT_DIR, default_query, safe_filename


def iter_attachment_parts(payload: dict):
    """Recursively yield parts that carry a real attachment."""
    stack = [payload]
    while stack:
        part = stack.pop()
        stack.extend(part.get("parts", []))
        filename = part.get("filename") or ""
        body = part.get("body", {})
        if filename and (body.get("attachmentId") or body.get("data")):
            yield filename, part


def header(msg: dict, name: str) -> str:
    for h in msg.get("payload", {}).get("headers", []):
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def fetch(gmail, query: str, dry_run: bool) -> None:
    OUT_DIR.mkdir(exist_ok=True)
    manifest_path = OUT_DIR / "manifest.csv"
    rows, skipped = [], []

    print(f"Gmail query: {query}\n")

    message_ids, page_token = [], None
    while True:
        resp = gmail.users().messages().list(
            userId="me", q=query, pageToken=page_token, maxResults=100
        ).execute()
        message_ids += [m["id"] for m in resp.get("messages", [])]
        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    print(f"{len(message_ids)} matching messages")

    for msg_id in message_ids:
        msg = gmail.users().messages().get(
            userId="me", id=msg_id, format="full"
        ).execute()
        sender = header(msg, "From")
        subject = header(msg, "Subject")
        msg_date = datetime.fromtimestamp(
            int(msg["internalDate"]) / 1000
        ).strftime("%Y-%m-%d")

        for filename, part in iter_attachment_parts(msg["payload"]):
            ext = Path(filename).suffix.lower()
            if ext not in KEEP_EXTENSIONS:
                skipped.append((msg_date, sender, filename, "extension"))
                continue

            out_name = f"{msg_date}_{msg_id[:8]}_{safe_filename(filename)}"
            out_path = OUT_DIR / out_name
            if dry_run:
                print(f"  would fetch: {out_name}  ({sender} — {subject})")
            else:
                body = part["body"]
                if body.get("attachmentId"):
                    att = gmail.users().messages().attachments().get(
                        userId="me", messageId=msg_id, id=body["attachmentId"]
                    ).execute()
                    data = att["data"]
                else:
                    data = body["data"]
                out_path.write_bytes(base64.urlsafe_b64decode(data))
                print(f"  fetched: {out_name}")

            rows.append({
                "file": out_name,
                "message_id": msg_id,
                "email_date": msg_date,
                "from": sender,
                "subject": subject,
            })

    if not dry_run:
        with manifest_path.open("w", newline="") as f:
            writer = csv.DictWriter(
                f, fieldnames=["file", "message_id", "email_date", "from", "subject"]
            )
            writer.writeheader()
            writer.writerows(rows)

    print(f"\n{len(rows)} attachments {'matched' if dry_run else 'downloaded'}")
    if skipped:
        print(f"{len(skipped)} attachments skipped (non-PDF/image extension):")
        for msg_date, sender, filename, reason in skipped:
            print(f"  {msg_date}  {filename!r}  from {sender}  [{reason}]")
    if not dry_run:
        print(f"Manifest: {manifest_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--query", help="Gmail search query (default: built from .env)")
    ap.add_argument("--dry-run", action="store_true", help="list matches only")
    args = ap.parse_args()

    gmail, _, _ = verified_services()
    fetch(gmail, args.query or default_query(), args.dry_run)


if __name__ == "__main__":
    main()
