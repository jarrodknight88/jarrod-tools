"""Step 6 — load CLEAN rows into the CLT recon and archive the files.

    python3 load.py --dry-run     # show exactly what would be written
    python3 load.py               # asks for confirmation, then loads
    python3 load.py --yes         # skip the confirmation prompt

Appends to_load.csv rows to the CLT recon tab (and the Processed tab if
configured), uploads the source PDFs/images to the CLT Drive archive
folder, and prints a summary. to_review.csv is left untouched for Jarrod.

This script NEVER writes a FLAG row: it only reads to_load.csv and
additionally re-checks each row's status column. If anything but CLEAN
appears there, it aborts before writing a single cell.
"""

import argparse
import csv
import mimetypes
import sys
from pathlib import Path

from googleapiclient.http import MediaFileUpload

import clt_config as config
from clt_auth import verified_services

HERE = Path(__file__).resolve().parent
INVOICE_DIR = HERE / "clt_invoices"


def recon_headers(sheets, sheet_id: str, tab: str) -> list[str]:
    header_row = int(config.get("RECON_HEADER_ROW", "1"))
    resp = sheets.spreadsheets().values().get(
        spreadsheetId=sheet_id, range=f"{tab}!{header_row}:{header_row}"
    ).execute()
    values = resp.get("values", [[]])
    return [h.strip() for h in values[0]]


def recon_row(row: dict, headers: list[str]) -> list[str]:
    """Place values under the recon's actual column headers.

    values.append writes left-to-right from column A with no header
    awareness, so we build a full-width row and drop each value at its
    configured column's index; other columns stay blank.
    """
    mapping = {
        config.require("RECON_COL_VENDOR"): row["vendor"],
        config.require("RECON_COL_DATE"): row["invoice_date"],
        config.require("RECON_COL_INVOICE"): row["invoice_number"],
        config.require("RECON_COL_AMOUNT"): row["total"],
        config.require("RECON_COL_DESC"):
            f"Invoice recovery (Gmail sweep) — {row['file']}",
    }
    missing = [name for name in mapping if name not in headers]
    if missing:
        sys.exit(
            f"ABORTING — recon tab headers {headers} don't include "
            f"{missing}. Fix RECON_COL_* in .env. Nothing written."
        )
    out = [""] * len(headers)
    for name, value in mapping.items():
        out[headers.index(name)] = value
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--to-load", default=str(HERE / "to_load.csv"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true", help="skip confirmation")
    args = ap.parse_args()

    to_load_path = Path(args.to_load)
    if not to_load_path.exists():
        sys.exit(f"{to_load_path} not found — run classify.py first.")

    with to_load_path.open() as f:
        rows = list(csv.DictReader(f))
    if not rows:
        print("to_load.csv is empty — nothing to load.")
        return

    # Hard gate: never write anything that isn't CLEAN.
    not_clean = [r["file"] for r in rows if r.get("status") != "CLEAN"]
    if not_clean:
        sys.exit(
            f"ABORTING — non-CLEAN rows found in to_load.csv: {not_clean}. "
            "FLAG rows must never be auto-loaded. Re-run classify.py."
        )

    _, sheets, drive = verified_services()
    recon_sheet = config.require("CLT_RECON_SHEET_ID")
    recon_tab = config.require("CLT_RECON_TAB")
    processed_sheet = config.get("CLT_PROCESSED_SHEET_ID")
    processed_tab = config.get("CLT_PROCESSED_TAB")
    archive_folder = config.require("DRIVE_ARCHIVE_FOLDER_ID")

    # Validate the column mapping against the live sheet up front so a
    # dry run catches mapping mistakes too.
    headers = recon_headers(sheets, recon_sheet, recon_tab)
    recon_values = [recon_row(r, headers) for r in rows]

    total = sum(float(r["total"]) for r in rows)
    print(f"About to load {len(rows)} invoices totaling ${total:,.2f} into "
          f"recon {recon_sheet[:12]}.../{recon_tab}")
    for r in rows:
        print(f"  {r['vendor']:<24} #{r['invoice_number']:<16} "
              f"{r['invoice_date']}  ${float(r['total']):>10,.2f}  ({r['file']})")

    if args.dry_run:
        print("\nDry run — nothing written.")
        return
    if not args.yes:
        answer = input("\nProceed? Type 'load' to confirm: ").strip().lower()
        if answer != "load":
            sys.exit("Aborted — nothing written.")

    # 1. Append to the recon, positioned under its actual headers.
    sheets.spreadsheets().values().append(
        spreadsheetId=recon_sheet,
        range=recon_tab,
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": recon_values},
    ).execute()
    print(f"\nAppended {len(rows)} rows to recon tab {recon_tab!r}.")

    # 2. Processed/intake tracker, if CLT uses one.
    if processed_sheet and processed_tab:
        sheets.spreadsheets().values().append(
            spreadsheetId=processed_sheet,
            range=processed_tab,
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": [
                [r["vendor"], r["invoice_date"], r["invoice_number"],
                 r["total"], r["file"], "loaded via clt-invoice-recovery"]
                for r in rows
            ]},
        ).execute()
        print(f"Appended {len(rows)} rows to processed tab {processed_tab!r}.")

    # 3. Archive source files to Drive.
    archived = 0
    for r in rows:
        src = INVOICE_DIR / r["file"]
        if not src.exists():
            print(f"  WARNING: {src} missing, not archived")
            continue
        mime = mimetypes.guess_type(src.name)[0] or "application/octet-stream"
        drive.files().create(
            body={"name": src.name, "parents": [archive_folder]},
            media_body=MediaFileUpload(str(src), mimetype=mime),
            fields="id",
        ).execute()
        archived += 1
    print(f"Archived {archived}/{len(rows)} files to Drive folder.")

    print(f"\nDone. Loaded {len(rows)} invoices (${total:,.2f}). "
          "to_review.csv still needs Jarrod's eyes.")


if __name__ == "__main__":
    main()
