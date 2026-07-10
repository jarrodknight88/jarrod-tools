# CLT Invoice Recovery Pipeline

End-to-end invoice recovery for **Teranga CLT (Charlotte)**, mirroring the ATL
process as scripts: sweep the Charlotte Gmail account, OCR image-only invoices,
parse totals, dedupe against the CLT recon, auto-load clean matches, and flag
edge cases for Jarrod.

## One-time setup (Step 1 — do this first, everything gates on it)

1. In Google Cloud Console, create (or reuse) a project and enable the
   **Gmail API**, **Google Sheets API**, and **Google Drive API**.
2. Create an OAuth client of type **Desktop app**; download the JSON as
   `credentials.json` into this directory.
3. `pip install -r requirements.txt` (Python 3.10+). Also install
   `poppler-utils` and `tesseract-ocr` (e.g. `brew install poppler tesseract`
   or `apt install poppler-utils tesseract-ocr`).
4. Copy `.env.example` to `.env` and fill it in — at minimum
   `CLT_GMAIL_ADDRESS` before running auth.
5. Run the consent flow **logged into the CHARLOTTE Gmail account**:

   ```
   python3 clt_auth.py
   ```

   It prints the authenticated email address. **Confirm it's the Charlotte
   account, not Brookhaven/ATL** — sweeping the wrong mailbox is the #1
   failure mode. The token is cached as `token_clt.json`; every script
   re-verifies the mailbox against `CLT_GMAIL_ADDRESS` on every run and
   refuses to proceed on a mismatch.

## Before loading anything, confirm with Jarrod

- The exact CLT **outage window** (`OUTAGE_START`/`OUTAGE_END` in `.env` are
  placeholders — dashboard showed ~mid-May to early July).
- The CLT recon **sheet ID, tab name, and column headers**
  (`RECON_COL_*` in `.env`).
- The **CLT entity names** as they appear on billed-to lines
  (`CLT_ENTITY_NAMES`). ATL lesson: invoices said "Clutch Restaurant", not
  "Teranga City". CLT will have its own version.
- Priority vendor list (Cheney Brothers, Restaurant Depot, ABC Spirits,
  US Foods per the recovery notes; Chef Sering's vendors may differ from ATL).
- CLT has its **own recon** — never point this at the ATL sheet.

## Pipeline

Run in order; each step writes what the next one reads.

| Step | Command | Output |
|---|---|---|
| Fetch | `python3 fetch_invoices.py [--dry-run]` | `clt_invoices/` + `manifest.csv` |
| Parse | `python3 parse_invoices.py` | `parsed.csv` |
| Classify | `python3 classify.py` | `to_load.csv`, `to_review.csv` |
| Load | `python3 load.py --dry-run`, then `python3 load.py` | recon rows + Drive archive |

- **Fetch** pulls attachment bytes straight through the Gmail API (no
  short-lived hydrate URLs) — PDFs **and** images. In ATL June, 3 of 6 hookah
  invoices were phone screenshots; a PDF-only sweep would have missed half.
  The default query combines priority vendors + `has:attachment` + the padded
  outage window; override with `--query`.
- **Parse** uses `pdftotext` when a text layer exists and falls back to
  `tesseract` OCR for image-only PDFs and images. Unreadable invoice #s or
  totals are recorded as issues, never guessed.
- **Classify** loads the recon once and applies the judgment gates below.
- **Load** appends CLEAN rows to the recon (and Processed tab if configured),
  archives files to the CLT Drive folder, and prints a summary. It re-checks
  every row's status and aborts if anything non-CLEAN slips into
  `to_load.csv`. **It never writes a FLAG row.** Default run asks for typed
  confirmation; use `--dry-run` first.

## Judgment gates (ATL lessons — every one of these bit us)

Flagged, never auto-loaded:

- **Entity ambiguity** — billed-to must match a `CLT_ENTITY_NAMES` entry
  (Clutch Restaurant ≠ Teranga City).
- **Out-of-window dates** — only invoice dates inside the gap window load.
- **Receipts / statements** — a paid CC receipt (Cintas $309.60) is not an
  open invoice.
- **Double-count risk** — vendor-month already has a lump-sum or ESTIMATE
  row: replace the estimate, don't stack line items on it.
- **OCR-unconfirmed invoice #s** — OCR misreads 0/O, 1/I, 5/S; confirm by eye.
- **Amount sanity** — flag anything beyond 2.5× (or under 0.2×) the vendor's
  recon average (Kurt May: $7,025 estimate vs $10,197 actual).
- Plus: unknown vendors, missing fields, and invoice#/amount+date collisions
  with existing recon rows.

Flagged items land in `to_review.csv` with reasons; Jarrod approves or
rejects each one by hand.

## Secrets

`credentials.json`, `token_clt.json`, and `.env` are git-ignored. Never
commit them.
