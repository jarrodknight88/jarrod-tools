"""Step 5 — dedupe against the CLT recon and split CLEAN vs FLAG.

    python3 classify.py [--parsed parsed.csv]

Loads the CLT recon once, then decides per parsed invoice:

  CLEAN (-> to_load.csv, eligible for auto-load by load.py):
    known vendor, invoice date inside the outage window, billed-to matches
    a CLT entity name, machine-read fields clean, a real invoice (not a
    receipt/statement), no invoice#/amount+date collision in the recon,
    no lump-sum/ESTIMATE row already covering that vendor-month, amount
    within the vendor's normal range.

  FLAG (-> to_review.csv, for Jarrod — NEVER auto-loaded):
    anything that fails a gate. Every ATL lesson is a gate here: entity
    ambiguity (Clutch Restaurant != Teranga City), out-of-window dates,
    receipts booked as invoices, ESTIMATE-row double-counts, OCR-shaky
    invoice #s, and Kurt-May-style amount surprises.
"""

import argparse
import csv
import re
import sys
from datetime import date, datetime
from pathlib import Path

import clt_config as config
from clt_auth import verified_services

HERE = Path(__file__).resolve().parent

ESTIMATE_MARKERS = re.compile(r"estimate|lump\s*sum|monthly\s+(?:total|accrual)|placeholder|accrual", re.I)


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def parse_amount(raw: str) -> float | None:
    cleaned = re.sub(r"[^\d.\-]", "", raw or "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_recon_date(raw: str) -> date | None:
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%b %d, %Y"):
        try:
            return datetime.strptime(raw.strip(), fmt).date()
        except (ValueError, AttributeError):
            continue
    return None


def load_recon(sheets) -> list[dict]:
    """Read the CLT recon tab into dicts keyed by configured header names."""
    sheet_id = config.require("CLT_RECON_SHEET_ID")
    tab = config.require("CLT_RECON_TAB")
    header_row = int(config.get("RECON_HEADER_ROW", "1"))

    resp = sheets.spreadsheets().values().get(
        spreadsheetId=sheet_id, range=tab
    ).execute()
    values = resp.get("values", [])
    if len(values) < header_row:
        sys.exit(f"Recon tab {tab!r} has no header row at row {header_row}.")

    headers = [h.strip() for h in values[header_row - 1]]
    required = {key: config.get(key) for key in
                ("RECON_COL_VENDOR", "RECON_COL_DATE", "RECON_COL_INVOICE",
                 "RECON_COL_AMOUNT", "RECON_COL_DESC")}
    missing = [f"{k}={v!r}" for k, v in required.items()
               if v and v not in headers]
    if missing:
        sys.exit(
            f"Recon headers {headers} don't contain: {', '.join(missing)}.\n"
            "Fix the RECON_COL_* values in .env to match the actual tab."
        )

    rows = []
    for raw in values[header_row:]:
        row = dict(zip(headers, raw + [""] * (len(headers) - len(raw))))
        rows.append({
            "vendor": row.get(required["RECON_COL_VENDOR"], ""),
            "date": parse_recon_date(row.get(required["RECON_COL_DATE"], "")),
            "invoice": row.get(required["RECON_COL_INVOICE"], "").strip(),
            "amount": parse_amount(row.get(required["RECON_COL_AMOUNT"], "")),
            "desc": row.get(required["RECON_COL_DESC"], ""),
        })
    return rows


def vendor_rows(recon: list[dict], vendor: str) -> list[dict]:
    v = norm(vendor)
    first = norm(vendor.split()[0]) if vendor else ""
    return [r for r in recon
            if v and (v in norm(r["vendor"]) or (len(first) > 3 and first in norm(r["vendor"])))]


def classify_row(row: dict, recon: list[dict], ctx: dict) -> list[str]:
    """Return list of flag reasons; empty list == CLEAN."""
    reasons = []

    vendor = row["vendor"]
    if not vendor:
        reasons.append("unknown vendor")

    # Gate: receipts/statements are not open invoices (Cintas $309.60 lesson).
    if row["doc_type"] == "receipt":
        reasons.append("payment receipt, not an invoice")
    elif row["doc_type"] == "statement":
        reasons.append("statement, not an invoice")
    elif row["doc_type"] != "invoice":
        reasons.append("document type unclear")

    # Gate: machine-read fields must be clean.
    if row["issues"]:
        reasons.append(f"parse issues: {row['issues']}")
    if not row["invoice_number"]:
        reasons.append("no invoice #")
    if not row["total"]:
        reasons.append("no total")

    # Gate: entity ambiguity (Clutch Restaurant lesson). If we found a
    # billed-to line it must match a known CLT entity name; if we found
    # none, that's ambiguous too.
    entities = [norm(e) for e in ctx["entity_names"]]
    billed = norm(row["billed_to"])
    if billed:
        if not any(e in billed or billed in e for e in entities if e):
            reasons.append(f"billed-to {row['billed_to']!r} doesn't match CLT entity names")
    else:
        reasons.append("no billed-to line found — entity unconfirmed")

    # Gate: date inside the outage window only.
    inv_date = None
    if row["invoice_date"]:
        inv_date = date.fromisoformat(row["invoice_date"])
        if not (ctx["start"] <= inv_date <= ctx["end"]):
            reasons.append(
                f"date {inv_date} outside outage window {ctx['start']}..{ctx['end']}"
            )
    else:
        reasons.append("no invoice date")

    amount = parse_amount(row["total"])
    vrows = vendor_rows(recon, vendor) if vendor else []

    # Gate: dedupe — invoice # collision, or same vendor+amount within 3 days.
    if row["invoice_number"]:
        inv_norm = norm(row["invoice_number"])
        if any(inv_norm and norm(r["invoice"]) == inv_norm for r in vrows):
            reasons.append(f"invoice # {row['invoice_number']} already in recon")
    if amount is not None and inv_date:
        for r in vrows:
            if r["amount"] is not None and abs(r["amount"] - amount) < 0.01 \
                    and r["date"] and abs((r["date"] - inv_date).days) <= 3:
                reasons.append(
                    f"possible duplicate: recon has {r['amount']:.2f} on {r['date']}"
                )
                break

    # Gate: double-count — vendor-month already carries a lump-sum/ESTIMATE
    # row. Loading line items on top double-counts; replace, don't stack.
    if inv_date:
        for r in vrows:
            if r["date"] and (r["date"].year, r["date"].month) == (inv_date.year, inv_date.month) \
                    and ESTIMATE_MARKERS.search(r["desc"] or ""):
                reasons.append(
                    f"{inv_date:%Y-%m} already has an estimate/lump-sum row for "
                    f"{vendor} ({r['desc']!r}) — replace it, don't stack"
                )
                break

    # Gate: amount sanity (Kurt May $7,025 estimate vs $10,197 actual lesson).
    amounts = [r["amount"] for r in vrows if r["amount"]]
    if amount is not None and amounts:
        avg = sum(amounts) / len(amounts)
        if avg > 0 and (amount > avg * ctx["high_mult"] or amount < avg * ctx["low_mult"]):
            reasons.append(
                f"amount {amount:.2f} far from {vendor} recon average {avg:.2f}"
            )

    return reasons


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--parsed", default=str(HERE / "parsed.csv"))
    args = ap.parse_args()

    parsed_path = Path(args.parsed)
    if not parsed_path.exists():
        sys.exit(f"{parsed_path} not found — run parse_invoices.py first.")

    _, sheets, _ = verified_services()
    recon = load_recon(sheets)
    start, end = config.outage_window()
    ctx = {
        "start": start,
        "end": end,
        "entity_names": config.get_list("CLT_ENTITY_NAMES"),
        "high_mult": float(config.get("AMOUNT_HIGH_MULT", "2.5")),
        "low_mult": float(config.get("AMOUNT_LOW_MULT", "0.2")),
    }
    print(f"Recon loaded: {len(recon)} rows. Window: {start}..{end}\n")

    with parsed_path.open() as f:
        parsed = list(csv.DictReader(f))

    to_load, to_review = [], []
    for row in parsed:
        reasons = classify_row(row, recon, ctx)
        out = dict(row)
        if reasons:
            out["status"] = "FLAG"
            out["flag_reasons"] = " | ".join(reasons)
            to_review.append(out)
            print(f"FLAG  {row['file']}: {out['flag_reasons']}")
        else:
            out["status"] = "CLEAN"
            out["flag_reasons"] = ""
            to_load.append(out)
            print(f"CLEAN {row['file']}: {row['vendor']} "
                  f"#{row['invoice_number']} {row['invoice_date']} ${row['total']}")

    fieldnames = list(parsed[0].keys()) + ["status", "flag_reasons"] if parsed else []
    for path, rows in ((HERE / "to_load.csv", to_load), (HERE / "to_review.csv", to_review)):
        with path.open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    print(f"\n{len(to_load)} CLEAN -> to_load.csv   {len(to_review)} FLAG -> to_review.csv")
    if to_review:
        print("Review to_review.csv with Jarrod before touching flagged items.")


if __name__ == "__main__":
    main()
