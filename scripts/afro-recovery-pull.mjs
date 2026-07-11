#!/usr/bin/env node
/**
 * Afro District — Full-Year Invoice Recovery: Phase 1 bulk attachment downloader
 * ------------------------------------------------------------------------------
 * Sweeps afrodistrictatl@gmail.com (Jan 1 – Dec 31, 2026) with the handoff's
 * query set, downloads invoice/receipt attachments, uploads them to Drive under
 *   Afro District Recovery 2026/{Vendor}/{YYYY-MM}/
 * and maintains manifest.csv (locally and in the Drive root folder).
 *
 * Run (from repo root, credentials.json in repo root):
 *   node scripts/afro-recovery-pull.mjs             # full run: download + Drive upload + manifest
 *   node scripts/afro-recovery-pull.mjs --dry-run   # sweep + manifest only, no downloads/uploads
 *   node scripts/afro-recovery-pull.mjs --local-only# download to disk + manifest, skip Drive
 *
 * Auth:
 *   credentials.json  OAuth client (installed app) at repo root. NEVER commit.
 *   token-afrodistrict.json  cached refresh token (auto-created on first run,
 *                            gitignored via token*.json). First run prints an
 *                            auth URL — sign in as afrodistrictatl@gmail.com.
 *   Scopes: gmail.readonly + drive.file
 *
 * Idempotent: rows already in the local manifest with a drive_file_id (or a
 * local_path when --local-only) are skipped on re-runs. Manifest merge key is
 * msg_id + filename.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const DRY_RUN = process.argv.includes("--dry-run");
const LOCAL_ONLY = process.argv.includes("--local-only");

const CREDENTIALS_PATH = process.env.CREDENTIALS || path.join(REPO_ROOT, "credentials.json");
const TOKEN_PATH = process.env.TOKEN || path.join(REPO_ROOT, "token-afrodistrict.json");
const OUT_DIR = process.env.OUT_DIR || path.join(REPO_ROOT, "afro-district/recovery-2026");
const FILES_DIR = path.join(OUT_DIR, "files");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.csv");

const DRIVE_ROOT_NAME = "Afro District Recovery 2026";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

/* Handoff Phase 1 query set — run all, dedupe by message ID. */
const QUERIES = [
  "{invoice receipt bill statement} has:attachment after:2026/01/01",
  "from:supersourceinc.com has:attachment after:2026/01/01",
  "from:cintas.com has:attachment after:2026/01/01",
  "from:opentable.com has:attachment after:2026/01/01",
  "from:toasttab.com has:attachment after:2026/01/01",
  "from:adp.com has:attachment after:2026/01/01",
  "from:ussbilling.com OR from:unitedsiteservicesinc.com has:attachment after:2026/01/01",
  "from:apexenvironmental.net has:attachment after:2026/01/01",
  "from:thecustomerfactor.com has:attachment after:2026/01/01",
  "filename:pdf after:2026/01/01",
  // safety net: everything with an attachment (superset; cheap since we dedupe)
  "has:attachment after:2026/01/01",
];

/* sender-domain → vendor label (folder name). Order matters: first match wins. */
const VENDOR_MAP = [
  ["supersourceinc.com", "Atlanta Super Source"],
  ["cintas.com", "Cintas"],
  ["opentable.com", "OpenTable"],
  ["toasttab.com", "Toast"],
  ["adp.com", "ADP"],
  ["theworknumber.com", "ADP"],
  ["ussbilling.com", "United Site Services"],
  ["unitedsiteservices", "United Site Services"], // covers .com and inc.com
  ["ussreceivables.com", "United Site Services"],
  ["apexenvironmental.net", "Apex Environmental"],
  ["thecustomerfactor.com", "Pristine Hood Vent"],
  ["comcast", "Comcast"],
  ["sysco.com", "Sysco"],
  ["adt.com", "ADT"],
  ["bill.com", "Bill.com"],
  ["diamonddistributors.info", "Diamond Distributors"],
  ["rndc-usa.com", "RNDC"],
  ["darlingii.com", "Darling Ingredients"],
  ["esog.biz", "ESOG"],
  ["fortressfpis.com", "Fortress Fire Protection"],
  ["sos.ga.gov", "GA Secretary of State"],
  ["atlantaga.gov", "City of Atlanta"],
  ["docusign.net", "DocuSign"],
  ["gas-south.com", "Gas South"],
  ["gassouth.com", "Gas South"],
  ["georgiapower.com", "Georgia Power"],
];

const MANIFEST_COLUMNS = [
  "msg_id", "msg_date", "sender", "subject", "vendor_guess", "filename",
  "drive_file_id", "drive_link", "processed", "amount", "invoice_no",
  "expense_month", "loaded_row",
];

/* ---------- OAuth (installed-app loopback flow, zero deps) ---------- */

function loadClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`Missing ${CREDENTIALS_PATH}. Put the OAuth client file (credentials.json) at the repo root.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const c = raw.installed || raw.web;
  if (!c) { console.error("credentials.json has neither 'installed' nor 'web' key."); process.exit(1); }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

async function tokenRequest(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${await res.text()}`);
  return res.json();
}

async function authorize() {
  const { clientId, clientSecret } = loadClient();

  if (fs.existsSync(TOKEN_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    const tok = await tokenRequest({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: saved.refresh_token, grant_type: "refresh_token",
    });
    return { accessToken: tok.access_token };
  }

  // First run: loopback consent flow.
  const port = 53682;
  const redirectUri = `http://127.0.0.1:${port}`;
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", state,
    login_hint: "afrodistrictatl@gmail.com",
  });
  console.log("\nAuthorize this app (sign in as afrodistrictatl@gmail.com):\n\n" + authUrl + "\n");

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.searchParams.get("state") !== state) { res.end("state mismatch"); return; }
      res.end("Authorized. You can close this tab and return to the terminal.");
      server.close();
      u.searchParams.get("code") ? resolve(u.searchParams.get("code")) : reject(new Error(u.searchParams.get("error") || "no code"));
    });
    server.listen(port, "127.0.0.1");
  });

  const tok = await tokenRequest({
    client_id: clientId, client_secret: clientSecret, code,
    grant_type: "authorization_code", redirect_uri: redirectUri,
  });
  if (!tok.refresh_token) { console.error("No refresh_token returned — remove prior grant at myaccount.google.com/permissions and retry."); process.exit(1); }
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({ refresh_token: tok.refresh_token }, null, 2));
  console.log(`Saved refresh token to ${TOKEN_PATH}`);
  return { accessToken: tok.access_token };
}

/* ---------- Google API helpers ---------- */

let ACCESS_TOKEN = "";

async function gapi(url, opts = {}, attempt = 1) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, ...(opts.headers || {}) },
  });
  if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    return gapi(url, opts, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 120)}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

const gjson = async (url, opts) => (await gapi(url, opts)).json();
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UP = "https://www.googleapis.com/upload/drive/v3";

/* ---------- Gmail sweep ---------- */

async function listMessageIds(q) {
  const ids = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ q, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gjson(`${GMAIL}/messages?${params}`);
    for (const m of data.messages || []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

function walkParts(part, out = []) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) {
    out.push({
      filename: part.filename,
      mimeType: part.mimeType || "application/octet-stream",
      size: part.body.size || 0,
      attachmentId: part.body.attachmentId,
    });
  }
  for (const p of part.parts || []) walkParts(p, out);
  return out;
}

const header = (msg, name) =>
  (msg.payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

/* Download rules: only PDF/image; skip .ics/.vcf; skip small images (signatures/logos). */
function keepAttachment(att) {
  const ext = path.extname(att.filename).toLowerCase();
  if ([".ics", ".vcf", ".vcs"].includes(ext)) return false;
  const isPdf = att.mimeType.includes("pdf") || ext === ".pdf";
  const isImage = att.mimeType.startsWith("image/") || [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".heic", ".webp"].includes(ext);
  if (!isPdf && !isImage) return false;
  if (isImage && !isPdf && att.size < 20 * 1024) return false; // signature/logo noise
  if (isImage && /signature|logo|banner|icon|footer|header|spacer|divider|img_line|inline|facebook|twitter|youtube|instagram|linkedin|tiktok|tagline/.test(att.filename.toLowerCase())) return false;
  return true;
}

function vendorGuess(sender, subject) {
  const s = sender.toLowerCase();
  for (const [needle, label] of VENDOR_MAP) if (s.includes(needle)) return label;
  const m = /@([a-z0-9.-]+)/.exec(s);
  if (m) {
    const dom = m[1].replace(/\.(com|net|org|biz|info|gov|us)$/i, "");
    return dom.split(".").pop().replace(/[^a-z0-9]+/gi, " ").trim() || "Unknown";
  }
  return subject ? subject.slice(0, 30) : "Unknown";
}

function invoiceNoGuess(...texts) {
  for (const t of texts) {
    if (!t) continue;
    const m =
      /\b(?:INV|FS|inv#?\s*|invoice\s*(?:no\.?|number|#)?\s*[:# ]?\s*)([A-Z]?\d{5,})/i.exec(t) ||
      /\b([A-Z]{1,4}-?\d{6,})\b/.exec(t) ||
      /#\s?(\d{4,})\b/.exec(t);
    if (m) return m[1].replace(/^\s+|\s+$/g, "");
  }
  return "";
}

const sanitize = s => s.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/* ---------- Drive helpers ---------- */

const folderCache = new Map(); // "parent/name" -> id

async function ensureFolder(name, parentId) {
  const key = `${parentId || "root"}/${name}`;
  if (folderCache.has(key)) return folderCache.get(key);
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ].join(" and ");
  const found = await gjson(`${DRIVE}/files?${new URLSearchParams({ q, fields: "files(id,name)" })}`);
  let id = found.files?.[0]?.id;
  if (!id) {
    const created = await gjson(`${DRIVE}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : [] }),
    });
    id = created.id;
  }
  folderCache.set(key, id);
  return id;
}

async function driveUpload(name, mimeType, buffer, parentId, existingId) {
  const boundary = "afro" + crypto.randomBytes(8).toString("hex");
  const meta = existingId ? { name } : { name, parents: [parentId] };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const url = existingId
    ? `${DRIVE_UP}/files/${existingId}?uploadType=multipart&fields=id,webViewLink`
    : `${DRIVE_UP}/files?uploadType=multipart&fields=id,webViewLink`;
  return gjson(url, {
    method: existingId ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

/* ---------- Manifest ---------- */

const csvEscape = v => {
  v = String(v ?? "");
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function loadManifest() {
  const rows = new Map(); // key msg_id|filename -> row object
  if (!fs.existsSync(MANIFEST_PATH)) return rows;
  const lines = fs.readFileSync(MANIFEST_PATH, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = parseCsvLine(lines[0]);
  for (const line of lines.slice(1)) {
    const vals = parseCsvLine(line);
    const row = Object.fromEntries(cols.map((c, i) => [c, vals[i] ?? ""]));
    rows.set(`${row.msg_id}|${row.filename}`, row);
  }
  return rows;
}

function saveManifest(rows) {
  const sorted = [...rows.values()].sort((a, b) => (a.msg_date || "").localeCompare(b.msg_date || ""));
  const out = [MANIFEST_COLUMNS.join(",")]
    .concat(sorted.map(r => MANIFEST_COLUMNS.map(c => csvEscape(r[c])).join(",")))
    .join("\n") + "\n";
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, out);
  return out;
}

/* ---------- main ---------- */

async function main() {
  ({ accessToken: ACCESS_TOKEN } = await authorize());

  console.log(`Sweeping ${QUERIES.length} queries...`);
  const idSet = new Set();
  for (const q of QUERIES) {
    const ids = await listMessageIds(q);
    ids.forEach(id => idSet.add(id));
    console.log(`  [${ids.length.toString().padStart(4)}] ${q}`);
  }
  console.log(`Deduped: ${idSet.size} unique messages.`);

  const manifest = loadManifest();
  const seenCopies = new Set(); // sender|filename|size dedup across messages (within a run)

  let nDownloaded = 0, nSkippedDup = 0, nFiltered = 0, nAlready = 0;
  let rootId = null;

  for (const msgId of idSet) {
    const msg = await gjson(`${GMAIL}/messages/${msgId}?format=full`);
    const atts = walkParts(msg.payload).filter(keepAttachment);
    if (!atts.length) { nFiltered++; continue; }

    const sender = header(msg, "From");
    const subject = header(msg, "Subject");
    const date = new Date(Number(msg.internalDate)).toISOString();
    const expMonth = date.slice(0, 7);
    const vendor = vendorGuess(sender, subject);

    for (const att of atts) {
      const key = `${msgId}|${att.filename}`;
      const existing = manifest.get(key);
      if (existing?.drive_file_id || (LOCAL_ONLY && existing?.processed === "Y")) { nAlready++; continue; }

      const copyKey = `${sender.toLowerCase()}|${att.filename}|${att.size}`;
      if (seenCopies.has(copyKey)) { nSkippedDup++; continue; }
      seenCopies.add(copyKey);

      const invoiceNo = invoiceNoGuess(att.filename, subject);
      const row = existing || {
        msg_id: msgId, msg_date: date, sender, subject,
        vendor_guess: vendor, filename: att.filename,
        drive_file_id: "", drive_link: "", processed: "N",
        amount: "", invoice_no: invoiceNo, expense_month: expMonth, loaded_row: "",
      };
      if (!row.invoice_no) row.invoice_no = invoiceNo;
      manifest.set(key, row);
      if (DRY_RUN) continue;

      // Download attachment bytes
      const attData = await gjson(`${GMAIL}/messages/${msgId}/attachments/${att.attachmentId}`);
      const buf = Buffer.from(attData.data, "base64url");
      if (att.mimeType.startsWith("image/") && buf.length < 20 * 1024) { manifest.delete(key); nFiltered++; continue; }

      const stamp = invoiceNo || date.slice(0, 10);
      const outName = sanitize(`${vendor}_${stamp}_${att.filename}`);
      const localDir = path.join(FILES_DIR, sanitize(vendor), expMonth);
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, outName), buf);

      if (!LOCAL_ONLY) {
        rootId ||= await ensureFolder(DRIVE_ROOT_NAME, null);
        const vendorId = await ensureFolder(sanitize(vendor), rootId);
        const monthId = await ensureFolder(expMonth, vendorId);
        const up = await driveUpload(outName, att.mimeType, buf, monthId);
        row.drive_file_id = up.id;
        row.drive_link = up.webViewLink || `https://drive.google.com/file/d/${up.id}/view`;
      }
      nDownloaded++;
      console.log(`  + ${outName} (${(buf.length / 1024).toFixed(0)} KB)`);
    }
  }

  const csv = saveManifest(manifest);
  console.log(`Manifest: ${MANIFEST_PATH} (${manifest.size} rows)`);

  if (!DRY_RUN && !LOCAL_ONLY) {
    rootId ||= await ensureFolder(DRIVE_ROOT_NAME, null);
    const q = `name = 'manifest.csv' and '${rootId}' in parents and trashed = false`;
    const found = await gjson(`${DRIVE}/files?${new URLSearchParams({ q, fields: "files(id)" })}`);
    const up = await driveUpload("manifest.csv", "text/csv", Buffer.from(csv), rootId, found.files?.[0]?.id);
    console.log(`Manifest uploaded to Drive (${up.id})`);
  }

  console.log(`Done. downloaded=${nDownloaded} already=${nAlready} dup-skipped=${nSkippedDup} filtered=${nFiltered}`);
}

main().catch(e => { console.error(e); process.exit(1); });
