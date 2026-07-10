"""Step 4 — parse downloaded invoices into parsed.csv.

    python3 parse_invoices.py [--dir ./clt_invoices]

Per file:
  - PDF with a text layer -> pdftotext
  - PDF without one, or any image -> OCR via tesseract (pdftoppm to
    rasterize PDFs first)
Extracts vendor, invoice #, date, total, plus a billed-to line and a
document-type guess (invoice vs receipt vs statement) that classify.py
uses for its judgment gates. Any field that can't be read cleanly is
recorded in the `issues` column rather than guessed silently.

Requires: pdftotext + pdftoppm (poppler-utils) and tesseract on PATH.
"""

import argparse
import csv
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import clt_config as config

HERE = Path(__file__).resolve().parent

PDF_EXT = {".pdf"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".tif", ".tiff", ".webp", ".bmp", ".heic"}

# If pdftotext yields fewer characters than this, assume image-only PDF.
MIN_TEXT_CHARS = 60

INVOICE_NO_PATTERNS = [
    re.compile(r"invoice\s*(?:no\.?|number|num\.?|#)?\s*[:.#]?\s*([A-Z0-9][A-Z0-9/-]{2,})", re.I),
    re.compile(r"\b(?:inv|ref(?:erence)?)\s*(?:no\.?|#)?\s*[:.#]?\s*([A-Z0-9][A-Z0-9/-]{2,})", re.I),
]

# Ordered: a labeled "total due"-style amount beats a bare "total".
TOTAL_PATTERNS = [
    re.compile(r"(?:total\s+due|amount\s+due|balance\s+due|total\s+amount|invoice\s+total|grand\s+total)\s*[:.]?\s*\$?\s*([\d,]+\.\d{2})", re.I),
    re.compile(r"\btotal\s*[:.]?\s*\$?\s*([\d,]+\.\d{2})", re.I),
]

DATE_PATTERNS = [
    (re.compile(r"(?:invoice\s+date|date\s+of\s+invoice|inv\.?\s+date)\s*[:.]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})", re.I), None),
    (re.compile(r"(?:invoice\s+date|date)\s*[:.]?\s*(\d{4}-\d{2}-\d{2})", re.I), "%Y-%m-%d"),
    (re.compile(r"(?:invoice\s+date|date)\s*[:.]?\s*([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})", re.I), None),
    (re.compile(r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b"), None),
]

# ATL lesson: paid receipts (Cintas $309.60) and statements are not open
# invoices. Order matters — check receipt/statement markers before "invoice".
RECEIPT_MARKERS = re.compile(
    r"payment\s+receipt|receipt\s+of\s+payment|payment\s+(?:received|confirmation)"
    r"|paid\s+(?:by|via|with)|thank\s+you\s+for\s+your\s+payment"
    r"|card\s+(?:ending|ending\s+in|x{2,})|\breceipt\b",
    re.I,
)
STATEMENT_MARKERS = re.compile(r"\bstatement\b|statement\s+of\s+account|account\s+summary", re.I)
INVOICE_MARKERS = re.compile(r"\binvoice\b", re.I)

BILLED_TO_PATTERN = re.compile(
    r"(?:bill(?:ed)?\s+to|sold\s+to|customer|ship\s+to)\s*[:.]?\s*\n?\s*([^\n]{3,60})", re.I
)


def require_tools():
    missing = [t for t in ("pdftotext", "pdftoppm", "tesseract") if not shutil.which(t)]
    if missing:
        sys.exit(f"Missing required tools on PATH: {', '.join(missing)}. "
                 "Install poppler-utils and tesseract-ocr.")


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {result.stderr.strip()[:200]}")
    return result.stdout


def ocr_image(path: Path) -> str:
    return run(["tesseract", str(path), "stdout", "--psm", "4"])


def extract_text(path: Path) -> tuple[str, bool]:
    """Return (text, ocr_used)."""
    ext = path.suffix.lower()
    if ext in PDF_EXT:
        text = run(["pdftotext", "-layout", str(path), "-"])
        if len(text.strip()) >= MIN_TEXT_CHARS:
            return text, False
        # Image-only PDF: rasterize each page and OCR.
        with tempfile.TemporaryDirectory() as tmp:
            run(["pdftoppm", "-r", "300", "-png", str(path), f"{tmp}/page"])
            pages = sorted(Path(tmp).glob("page*.png"))
            return "\n".join(ocr_image(p) for p in pages), True
    if ext in IMAGE_EXT:
        return ocr_image(path), True
    raise ValueError(f"unsupported extension {ext}")


def parse_date(raw: str) -> str | None:
    raw = raw.strip().rstrip(".,")
    formats = ["%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%m-%d-%y", "%Y-%m-%d",
               "%B %d, %Y", "%B %d %Y", "%b %d, %Y", "%b %d %Y", "%b. %d, %Y"]
    for fmt in formats:
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


# Words too generic to identify a vendor on their own.
GENERIC_VENDOR_WORDS = {"restaurant", "foods", "food", "supply", "supplies",
                        "services", "company", "wholesale", "distributors"}


def match_vendor(text: str, sender: str, vendors: list[str]) -> str:
    haystacks = (text.lower(), sender.lower())
    # Pass 1: full vendor name anywhere.
    for vendor in vendors:
        if any(vendor.lower() in hay for hay in haystacks):
            return vendor
    # Pass 2: distinctive first word only (e.g. "Cheney" matches
    # "Cheney Bros."), never generic words like "Restaurant".
    for vendor in vendors:
        first = vendor.lower().split()[0]
        if len(first) > 3 and first not in GENERIC_VENDOR_WORDS \
                and any(first in hay for hay in haystacks):
            return vendor
    return ""


def classify_doc_type(text: str) -> str:
    if RECEIPT_MARKERS.search(text) and not re.search(r"amount\s+due|balance\s+due", text, re.I):
        return "receipt"
    if STATEMENT_MARKERS.search(text) and not INVOICE_MARKERS.search(text):
        return "statement"
    if INVOICE_MARKERS.search(text):
        return "invoice"
    return "unknown"


def parse_file(path: Path, sender: str, vendors: list[str]) -> dict:
    issues = []
    try:
        text, ocr_used = extract_text(path)
    except (RuntimeError, ValueError) as e:
        return {"file": path.name, "vendor": "", "invoice_number": "",
                "invoice_date": "", "total": "", "doc_type": "unknown",
                "billed_to": "", "ocr_used": "", "issues": f"extract failed: {e}"}

    vendor = match_vendor(text, sender, vendors)
    if not vendor:
        issues.append("vendor not recognized")

    invoice_no = ""
    for pat in INVOICE_NO_PATTERNS:
        # Overlap-safe scan: a rejected match (e.g. a bare "INVOICE"
        # heading capturing the next line's "Invoice" label) must not
        # consume text the real label needs, so re-search from just past
        # each rejected match start rather than its end.
        pos = 0
        while m := pat.search(text, pos):
            candidate = m.group(1).rstrip(".,:;")
            # A real invoice number contains a digit.
            if re.search(r"\d", candidate):
                invoice_no = candidate
                break
            pos = m.start() + 1
        if invoice_no:
            break
    if not invoice_no:
        issues.append("invoice # not found")
    elif ocr_used:
        # OCR-read invoice numbers are easy to misread (0/O, 1/I, 5/S).
        issues.append("invoice # from OCR — confirm")

    invoice_date = ""
    for pat, _ in DATE_PATTERNS:
        m = pat.search(text)
        if m and (parsed := parse_date(m.group(1))):
            invoice_date = parsed
            break
    if not invoice_date:
        issues.append("date not found")

    total = ""
    for pat in TOTAL_PATTERNS:
        amounts = pat.findall(text)
        if amounts:
            values = [float(a.replace(",", "")) for a in amounts]
            total = f"{max(values):.2f}"
            if len(set(values)) > 1:
                issues.append(f"multiple candidate totals {sorted(set(values))} — took max")
            break
    if not total:
        issues.append("total not found")

    billed_to = ""
    if m := BILLED_TO_PATTERN.search(text):
        billed_to = m.group(1).strip()

    return {
        "file": path.name,
        "vendor": vendor,
        "invoice_number": invoice_no,
        "invoice_date": invoice_date,
        "total": total,
        "doc_type": classify_doc_type(text),
        "billed_to": billed_to,
        "ocr_used": "yes" if ocr_used else "no",
        "issues": "; ".join(issues),
    }


def load_manifest(folder: Path) -> dict[str, str]:
    """file -> sender, for vendor hinting."""
    manifest = folder / "manifest.csv"
    if not manifest.exists():
        return {}
    with manifest.open() as f:
        return {row["file"]: row.get("from", "") for row in csv.DictReader(f)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", default=str(HERE / "clt_invoices"))
    ap.add_argument("--out", default=str(HERE / "parsed.csv"))
    args = ap.parse_args()

    require_tools()
    folder = Path(args.dir)
    if not folder.is_dir():
        sys.exit(f"{folder} does not exist — run fetch_invoices.py first.")

    vendors = config.get_list("PRIORITY_VENDORS")
    senders = load_manifest(folder)

    files = sorted(
        p for p in folder.iterdir()
        if p.suffix.lower() in PDF_EXT | IMAGE_EXT
    )
    if not files:
        sys.exit(f"No PDFs or images in {folder}.")

    rows = []
    for path in files:
        row = parse_file(path, senders.get(path.name, ""), vendors)
        rows.append(row)
        status = "OK " if not row["issues"] else "!! "
        print(f"{status}{path.name}: vendor={row['vendor'] or '?'} "
              f"inv={row['invoice_number'] or '?'} date={row['invoice_date'] or '?'} "
              f"total={row['total'] or '?'} type={row['doc_type']}"
              + (f"  [{row['issues']}]" if row["issues"] else ""))

    out = Path(args.out)
    with out.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    flagged = sum(1 for r in rows if r["issues"])
    print(f"\n{len(rows)} files parsed -> {out}  ({flagged} with issues)")


if __name__ == "__main__":
    main()
