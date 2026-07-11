# Afro District — Full-Year Invoice Recovery: Claude Code Handoff

**Goal:** Download ALL invoice/receipt attachments from afrodistrictatl@gmail.com for Jan 1 – Dec 31, 2026 into Google Drive, produce a manifest CSV, then process into the recon sheet.

**Repo:** `jarrodknight88/jarrod-tools` (same pattern as CLT recovery pipeline)
**Gmail account:** afrodistrictatl@gmail.com (connect via OAuth, same as Charlotte account)
**Recon sheet:** https://docs.google.com/spreadsheets/d/1Jo4gMHhmGRVvmHKbCFuFzuBXkfjlmdMK-Yg_S86jAEY
**Target tabs:** Expense Detail (variable expenses) · Monthly Bills (recurring, one yellow cell per vendor per month)

---

## Phase 1 — Bulk attachment download

### Gmail search queries (run all, dedupe by message ID)
1. `{invoice receipt bill statement} has:attachment after:2026/01/01`
2. `from:supersourceinc.com has:attachment after:2026/01/01`
3. `from:cintas.com has:attachment after:2026/01/01`
4. `from:opentable.com has:attachment after:2026/01/01`
5. `from:toasttab.com has:attachment after:2026/01/01`
6. `from:adp.com has:attachment after:2026/01/01`
7. `from:ussbilling.com OR from:unitedsiteservicesinc.com has:attachment after:2026/01/01`
8. `from:apexenvironmental.net has:attachment after:2026/01/01`
9. `from:thecustomerfactor.com has:attachment after:2026/01/01`
10. Catch-all sweep: `filename:pdf after:2026/01/01` (filter out contracts/marketing manually via manifest)

### Download rules
- Only PDF/image attachments; skip .ics, signatures, logos (<20KB images)
- Drive folder: `Afro District Recovery 2026/{Vendor}/{YYYY-MM}/`
- Filename convention: `{vendor}_{invoice# or msgdate}_{originalname}.pdf`
- Skip duplicates: same attachment filename + size from same sender = one copy

### Manifest CSV (`manifest.csv` in root folder)
Columns: `msg_id, msg_date, sender, subject, vendor_guess, filename, drive_file_id, drive_link, processed(Y/N), amount, invoice_no, expense_month, loaded_row`

## Phase 2 — Processing rules (after download)
- OCR scanned PDFs via Drive copy/convert to Google Doc (established pipeline)
- Extract: vendor, invoice #, invoice date, total
- **Dedup before loading** (hard rule): match against existing Expense Detail rows on vendor + amount ±$1 + date ±10 days; and against invoice # in Notes. Log skips in manifest.
- Load convention: Date = month-end bucket (e.g. 5/31/2026), Notes = `EMAIL-RECOVERY invoice {#} {date} - {source}`
- Recurring vendors (Toast software, OpenTable, ADP fees, Cintas, Apex, utilities) → Monthly Bills yellow cells, NOT Expense Detail
- Sheets writes: `values:append` / `values:batchUpdate` with `valueInputOption=USER_ENTERED`

## Known expected attachments (from inbox survey, Mar–Jul)
| Vendor | Cadence | Notes |
|---|---|---|
| Atlanta Super Source | ~2x/week + monthly LEASE invoice + monthly statement | Biggest gap; sheet has 1 entry ($630.59) |
| Toast software | Monthly (~$1,564–1,616) | INV9355673 $4,652.42 REJECTED 5/5 — verify if repaid |
| OpenTable | Monthly (FS1814696, ~$914 expected) | |
| Cintas | Weekly/biweekly invoices + monthly statements | |
| ADP | Per-payroll fees ($461.30 Jun, $287.32 Jul in-body) | |
| United Site Services | Per-invoice + collections notices | Failed CC autopay ACT-02130063 |
| Apex Environmental | Monthly (~$300, grease trap) | 6/25 invoice #298431 paid via Bill.com |
| Pristine Hood Vent | Per-service | #3736 (6/17) UNPAID |
| Toast CC processing | Monthly statement (small fees) | |

## Already loaded via in-body recovery (do NOT reload)
Expense Detail rows 195–205, all tagged `EMAIL-RECOVERY` in Notes:
- Diamond Distributors ×3 (PayTrace refs 700363419, 702116138, 699634209)
- Iron.Solid INV0001 $1,648 / INV0002 $2,154.34 (PAID 6/29 NFCU ACH) / INV0003 $2,983
- Bank transfers ×5 pending owner confirmation ($30,222.50 incl. $19,239 wire 7/3)
Monthly Bills: Gas South Mar $299.03, May $305.46 loaded.

## In-body items still queued (chat side, no PDFs needed)
- NFCU ACH amounts 7/7 + 7/9 (add to owner confirmation list)
- Georgia Power payments 5/19 + 7/4 + two March drafted bills (two meters?)
- Gas South: April payment amount + NEW Jan/Feb history (past-due $346.42 paid 2/24 — pull Jan–Feb bills/payments)
- Comcast payment 3/16 + Jan–Feb payment history
- ADT EasyPay ×4 (4/6, 5/6, 6/6, 7/6) + one-time charges; ADT active since at least Feb (work order 2/16)
- Apex Bill.com payments 3/27 + 6/25 amounts
- GA Secretary of State annual registration fee (filed 2/25)

## Open fires (action, not bookkeeping)
1. Gas South past due $1,773.18, due 7/21, autopay failing since 6/22
2. Toast invoice INV9355673 $4,652.42 rejected 5/5 — confirm resolution
3. Comcast past-due alerts (Feb AND June streaks)
4. United Site Services failed CC + unpaid invoices (collections calling)
5. Iron.Solid INV0003 $2,983 due 7/14; INV0001 $1,648 verify paid
6. Pristine Hood Vent #3736 unpaid
