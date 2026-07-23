#!/usr/bin/env node
/**
 * CardsHQ Inventory Dashboard - daily pull
 * ----------------------------------------
 * Queries the Shopify Admin API, buckets card inventory, and writes data.json
 * in the exact record shape the dashboard renders:
 *   { date, generatedAt, scope, isSample:false, records:[
 *     { category, subject, tier, cond, onhand, p:{ daily:{ in, out } } }
 *   ]}
 * (weekly/monthly windows are deferred - daily only for v1.)
 *
 * Run:
 *   SHOPIFY_STORE=your-store SHOPIFY_ADMIN_TOKEN=shpat_xxx node scripts/pull-inventory.mjs
 *
 * Env:
 *   SHOPIFY_STORE         store handle or full domain (e.g. "cardshq" or "cardshq.myshopify.com")
 *   SHOPIFY_ADMIN_TOKEN   Admin API access token (custom app). NEVER commit this.
 *   API_VERSION           optional, defaults to 2025-01
 *   OUT                   optional output path, defaults to cardshq/inventory-dashboard/data.json
 *
 * Required custom-app scopes: read_products, read_orders
 *   (read_orders covers all channels including POS; read_inventory and read_locations are fine to have too)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const STORE = (process.env.SHOPIFY_STORE || "").replace(/\.myshopify\.com$/, "");
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.API_VERSION || "2025-01";
const OUT = process.env.OUT || path.join(REPO_ROOT, "cardshq/inventory-dashboard/data.json");
const SNAP_DIR = process.env.SNAP_DIR || path.join(REPO_ROOT, "cardshq/inventory-dashboard/snapshots");
const TZ = "America/New_York";

if (!STORE || !TOKEN) {
  console.error("Missing SHOPIFY_STORE or SHOPIFY_ADMIN_TOKEN env vars.");
  process.exit(1);
}

const CONFIG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "cardshq/inventory-dashboard/tags.config.json"), "utf8")
);
const ENDPOINT = `https://${STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;

// Sanity cap on a single sold unit price. No single card CardsHQ sells approaches
// this; anything above it is corrupt source data (e.g. a barcode scanned into a
// Shopify price field - the 2026-07-07 incident was a 12-digit catalog price on a
// graded Pokemon single). Offending lines are excluded from money sums and logged
// to `anomalies` in data.json so they surface instead of silently blowing up totals.
const MAX_UNIT_PRICE = 250000;
const anomalies = [];

/* ---------- Shopify GraphQL helper (with basic retry) ---------- */
async function gql(query, variables = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    if (body.errors) {
      // Throttled -> back off and retry; otherwise fail loudly.
      const throttled = JSON.stringify(body.errors).includes("THROTTLED");
      if (throttled && attempt < 5) { await sleep(1500 * attempt); continue; }
      throw new Error("GraphQL error: " + JSON.stringify(body.errors));
    }
    return body.data;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Date window: "yesterday" in store timezone ---------- */
function yesterdayWindow() {
  const now = new Date();
  // Today's date parts in store TZ
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  const todayET = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00`);
  const startET = new Date(todayET); startET.setDate(startET.getDate() - 1); // yesterday 00:00 ET
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { day: fmt(startET), start: `${fmt(startET)}T00:00:00`, end: `${parts.year}-${parts.month}-${parts.day}T00:00:00` };
}

/* ---------- Classifiers ---------- */
const SUBJECT_BY_TAG = (() => {
  const m = new Map();
  for (const s of CONFIG.subjects) for (const t of s.tags) m.set(t.toLowerCase(), s);
  return m;
})();
function classifySubject(tags = []) {
  for (const t of tags) { const hit = SUBJECT_BY_TAG.get(String(t).toLowerCase()); if (hit) return hit; }
  return CONFIG.uncategorized;
}
function classifyCondition(productType) {
  for (const [cond, rule] of Object.entries(CONFIG.condition)) {
    if ((rule.productTypes || []).includes(productType)) return cond;
  }
  return null; // not a card
}
function classifyTier(price) {
  const p = Number(price) || 0;
  for (const t of CONFIG.priceTiers) if (p >= t.min) return t.key; // tiers are ordered high -> low
  return CONFIG.priceTiers[CONFIG.priceTiers.length - 1].key;
}

/* ---------- Aggregation store ---------- */
const recs = new Map(); // key -> record
const keyOf = (r) => `${r.category}|${r.subject}|${r.cond}|${r.tier}`;
const money = (v) => Math.round((Number(v) || 0) * 100) / 100; // 2dp, avoids float drift
function ensure(slice) {
  const k = keyOf(slice);
  if (!recs.has(k)) recs.set(k, {
    category: slice.category, subject: slice.subject, tier: slice.tier, cond: slice.cond,
    onhand: 0,
    // on-hand valuation: what the shelf is worth at cost vs retail
    val: { cost: 0, retail: 0 },
    p: { daily: {
      in: 0, out: 0,
      // buy-side money received yesterday (cost paid, retail listed)
      inCost: 0, inRetail: 0,
      // sold-side money moved yesterday
      soldCost: 0, soldRevenue: 0,
    }},
  });
  return recs.get(k);
}
// units on hand + on-hand valuation, in one call
function bumpOnhand(slice, units, unitCost, unitPrice) {
  const rec = ensure(slice);
  rec.onhand += units;
  rec.val.cost = money(rec.val.cost + units * (Number(unitCost) || 0));
  rec.val.retail = money(rec.val.retail + units * (Number(unitPrice) || 0));
}
// intake ("in") or sold ("out") unit counts
function bumpFlow(slice, field, units) {
  ensure(slice).p.daily[field] += units;
}
// intake money: what we paid (cost) and listed (retail) for units received today.
// Buy-side dollars for the monthly buy/sell view - previously only units were kept.
function bumpIntakeValue(slice, unitCost, unitPrice) {
  const rec = ensure(slice);
  rec.p.daily.inCost = money((rec.p.daily.inCost || 0) + (Number(unitCost) || 0));
  rec.p.daily.inRetail = money((rec.p.daily.inRetail || 0) + (Number(unitPrice) || 0));
}
// sold-side money for margin (revenue and cost of what sold yesterday)
function bumpSold(slice, units, unitCost, unitPrice) {
  const rec = ensure(slice);
  rec.p.daily.soldCost = money(rec.p.daily.soldCost + units * (Number(unitCost) || 0));
  rec.p.daily.soldRevenue = money(rec.p.daily.soldRevenue + units * (Number(unitPrice) || 0));
}

/* ---------- 1) On-hand + intake from products ---------- */
const CARD_TYPE_FILTER = CONFIG.cardProductTypes.map((t) => `product_type:'${t}'`).join(" OR ");
const CARDS_QUERY = `
query Cards($cursor: String) {
  products(first: 250, after: $cursor, query: "${CARD_TYPE_FILTER}") {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id productType tags createdAt
      variants(first: 10) { edges { node { price inventoryQuantity inventoryItem { unitCost { amount } } } } }
    }}
  }
}`;

async function pullProducts(win) {
  let cursor = null, pages = 0, products = 0;
  do {
    const data = await gql(CARDS_QUERY, { cursor });
    const conn = data.products;
    for (const { node } of conn.edges) {
      const cond = classifyCondition(node.productType);
      if (!cond) continue; // not a card
      const subj = classifySubject(node.tags);
      const variants = node.variants.edges.map((e) => e.node);
      const price = variants[0] ? Number(variants[0].price) || 0 : 0;
      const unitCost = variants[0] && variants[0].inventoryItem && variants[0].inventoryItem.unitCost
        ? Number(variants[0].inventoryItem.unitCost.amount) || 0 : 0;
      const onhand = variants.reduce((a, v) => a + (v.inventoryQuantity || 0), 0);
      const tier = classifyTier(price);
      const slice = { category: subj.category, subject: subj.name, cond, tier };
      if (onhand > 0) bumpOnhand(slice, onhand, unitCost, price);
      // Intake: each single created yesterday counts as 1 unit in (one-of-one model).
      // NOTE v1 assumption: 1 unit per new single. Multi-qty intake/restocks refine later.
      if (node.createdAt >= toISO(win.start) && node.createdAt < toISO(win.end)) {
        bumpFlow(slice, "in", 1);
        bumpIntakeValue(slice, unitCost, price);
      }
      products++;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
  } while (cursor);
  return { pages, products };
}
const toISO = (local) => new Date(local).toISOString();

/* ---------- 2) Sold yesterday from orders ---------- */
// Revenue price for a sold line: the amount actually charged (net of discounts),
// falling back to the variant's catalog price only if the charged amount is absent.
// Returns null (and logs an anomaly) when the price fails the sanity cap; callers
// still count the unit as physically out but exclude its money from the sums.
function soldLinePrice(li, day, subj) {
  const charged = li.discountedUnitPriceSet && li.discountedUnitPriceSet.shopMoney
    ? Number(li.discountedUnitPriceSet.shopMoney.amount) : NaN;
  const catalog = li.variant ? Number(li.variant.price) : NaN;
  const price = Number.isFinite(charged) ? charged : (Number.isFinite(catalog) ? catalog : 0);
  if (price > MAX_UNIT_PRICE) {
    anomalies.push({
      date: day, category: subj.category, subject: subj.name,
      qty: li.quantity || 0, price,
      note: "unit price above sanity cap - excluded from revenue; check the product's price in Shopify",
    });
    return null;
  }
  return price;
}

const SOLD_QUERY = `
query Sold($cursor: String, $q: String!) {
  orders(first: 100, after: $cursor, query: $q) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id
      lineItems(first: 100) { edges { node {
        quantity
        discountedUnitPriceSet { shopMoney { amount } }
        product { productType tags }
        variant { price inventoryItem { unitCost { amount } } }
      }}}
    }}
  }
}`;

async function pullSold(win) {
  const q = `created_at:>='${win.start}' created_at:<'${win.end}'`;
  let cursor = null, orders = 0, units = 0;
  do {
    const data = await gql(SOLD_QUERY, { cursor, q });
    const conn = data.orders;
    for (const { node } of conn.edges) {
      for (const { node: li } of node.lineItems.edges) {
        if (!li.product) continue; // deleted product
        const cond = classifyCondition(li.product.productType);
        if (!cond) continue; // not a card (wax, supplies, etc.)
        const subj = classifySubject(li.product.tags);
        const price = soldLinePrice(li, win.day, subj);
        const unitCost = li.variant && li.variant.inventoryItem && li.variant.inventoryItem.unitCost
          ? Number(li.variant.inventoryItem.unitCost.amount) || 0 : 0;
        const qty = li.quantity || 0;
        // Tier from catalog price (bucketing), capped so a corrupt price cannot mis-tier.
        const tierPrice = Math.min(li.variant ? Number(li.variant.price) || 0 : 0, MAX_UNIT_PRICE);
        const slice = { category: subj.category, subject: subj.name, cond, tier: classifyTier(tierPrice) };
        bumpFlow(slice, "out", qty);
        bumpSold(slice, qty, unitCost, price === null ? 0 : price);
        units += qty;
      }
      orders++;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return { orders, units };
}

/* ---------- 3) History: daily rollups + June sold-side backfill ---------- */
const HISTORY_BACKFILL_START = "2026-06-01"; // sold-side history begins here
const BACKFILL_MAX_PER_RUN = 40;             // bound runtime on first run

// Rollup a records array into totals + per-category summaries.
function rollupRecords(records) {
  const zero = () => ({ onhand: 0, cost: 0, retail: 0, in: 0, inCost: 0, inRetail: 0, out: 0, soldCost: 0, soldRevenue: 0 });
  const totals = zero(), byCategory = {};
  for (const r of records) {
    const c = (byCategory[r.category] = byCategory[r.category] || zero());
    for (const t of [totals, c]) {
      t.onhand += r.onhand;
      t.cost = money(t.cost + (r.val ? r.val.cost : 0));
      t.retail = money(t.retail + (r.val ? r.val.retail : 0));
      t.in += r.p.daily.in; t.out += r.p.daily.out;
      t.inCost = money(t.inCost + (r.p.daily.inCost || 0));
      t.inRetail = money(t.inRetail + (r.p.daily.inRetail || 0));
      t.soldCost = money(t.soldCost + (r.p.daily.soldCost || 0));
      t.soldRevenue = money(t.soldRevenue + (r.p.daily.soldRevenue || 0));
    }
  }
  return { totals, byCategory };
}

// Sold-side only, for one past day - own accumulator, does not touch `recs`.
async function soldSummaryForDay(dayStr) {
  const next = new Date(`${dayStr}T00:00:00`); next.setDate(next.getDate() + 1);
  const f = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const q = `created_at:>='${dayStr}T00:00:00' created_at:<'${f(next)}T00:00:00'`;
  const zero = () => ({ onhand: null, cost: null, retail: null, in: null, out: 0, soldCost: 0, soldRevenue: 0 });
  const totals = zero(), byCategory = {};
  let cursor = null;
  do {
    const data = await gql(SOLD_QUERY, { cursor, q });
    const conn = data.orders;
    for (const { node } of conn.edges) {
      for (const { node: li } of node.lineItems.edges) {
        if (!li.product) continue;
        const cond = classifyCondition(li.product.productType);
        if (!cond) continue; // cards only - matches dashboard scope
        const subj = classifySubject(li.product.tags);
        const price = soldLinePrice(li, dayStr, subj);
        const unitCost = li.variant && li.variant.inventoryItem && li.variant.inventoryItem.unitCost
          ? Number(li.variant.inventoryItem.unitCost.amount) || 0 : 0;
        const qty = li.quantity || 0;
        const c = (byCategory[subj.category] = byCategory[subj.category] || zero());
        for (const t of [totals, c]) {
          t.out += qty;
          t.soldCost = money(t.soldCost + qty * unitCost);
          t.soldRevenue = money(t.soldRevenue + qty * (price === null ? 0 : price));
        }
      }
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return { totals, byCategory };
}

// All dates from start (inclusive) to end (exclusive), as YYYY-MM-DD.
function dateRange(startStr, endStr) {
  const out = [];
  const d = new Date(`${startStr}T00:00:00`), end = new Date(`${endStr}T00:00:00`);
  while (d < end) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/* ---------- 4) Derived on-hand history ----------
 * Cost and price are fixed at intake and graded cards are one-of-one, so
 * past on-hand value is reconstructable by walking backward from the first
 * recorded anchor:  V(D) = V(D+1) + soldCost(D+1) - intakeCost(D+1)
 * Graded is near-exact; raw is estimated (restocks and manual adjustments
 * outside product-creation are not reconstructable). */
const INTAKE_QUERY = `
query Intake($cursor: String, $q: String!) {
  products(first: 250, after: $cursor, query: $q) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      productType tags createdAt
      variants(first: 1) { edges { node { price inventoryItem { unitCost { amount } } } } }
    }}
  }
}`;

// One range query: bucket intake units/cost/retail by creation day (store TZ).
async function intakeByDay(startDay, endDayExclusive) {
  const q = `(${CARD_TYPE_FILTER}) AND created_at:>='${startDay}T00:00:00' AND created_at:<'${endDayExclusive}T00:00:00'`;
  const days = {};
  const dayOf = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  let cursor = null, pages = 0;
  do {
    const data = await gql(INTAKE_QUERY, { cursor, q });
    const conn = data.products;
    for (const { node } of conn.edges) {
      if (!classifyCondition(node.productType)) continue; // cards only
      const v = node.variants.edges[0] ? node.variants.edges[0].node : null;
      const price = v ? Number(v.price) || 0 : 0;
      const unitCost = v && v.inventoryItem && v.inventoryItem.unitCost ? Number(v.inventoryItem.unitCost.amount) || 0 : 0;
      const day = dayOf(node.createdAt);
      const b = (days[day] = days[day] || { units: 0, cost: 0, retail: 0, byCategory: {} });
      b.units += 1; // one-of-one intake model, matches the daily "in" metric
      b.cost = money(b.cost + unitCost);
      b.retail = money(b.retail + price);
      const cat = classifySubject(node.tags).category;
      const cb = (b.byCategory[cat] = b.byCategory[cat] || { units: 0, cost: 0, retail: 0 });
      cb.units += 1;
      cb.cost = money(cb.cost + unitCost);
      cb.retail = money(cb.retail + price);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
  } while (cursor);
  return { days, pages };
}

// Fill derived on-hand values for all pre-anchor days. Idempotent via DERIVE_V.
// Both passes (totals and per-category) ALWAYS recompute together from the same
// anchor in the same run - deriving them in separate runs against a moving
// anchor produces a constant cross-section offset, so coherence requires one run.
// v4: adds buy-side dollars (inCost/inRetail) to derived history days.
const DERIVE_V = 4;
async function deriveOnhandHistory(history) {
  const anchorIdx = history.findIndex((h) => h.onhandKnown);
  if (anchorIdx <= 0) return 0; // no anchor or nothing before it
  const pre = history.slice(0, anchorIdx);
  const pending = pre.filter((h) => h.deriveV !== DERIVE_V);
  if (pending.length === 0) return 0;

  const startDay = history[0].date;
  const anchor = history[anchorIdx];
  // Intake range must INCLUDE the anchor day: the first backward step
  // (anchor -> last pre-anchor day) subtracts the anchor day's intake.
  const dayAfterAnchor = (() => { const d = new Date(`${anchor.date}T00:00:00`); d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  console.error(`Deriving on-hand history ${startDay} -> ${anchor.date} (intake pull)...`);
  const { days: intake, pages } = await intakeByDay(startDay, dayAfterAnchor);
  console.error(`Intake bucketed across ${pages} pages.`);

  // ---- Pass 1: totals. V(D) = V(D+1) + soldCost(D+1) - intakeCost(D+1) ----
  {
    let next = anchor;
    for (let i = anchorIdx - 1; i >= 0; i--) {
      const h = history[i];
      const inNext = intake[next.date] || { units: 0, cost: 0, retail: 0 };
      h.totals.onhand = (next.totals.onhand || 0) + (next.totals.out || 0) - inNext.units;
      h.totals.cost = money((next.totals.cost || 0) + (next.totals.soldCost || 0) - inNext.cost);
      h.totals.retail = money((next.totals.retail || 0) + (next.totals.soldRevenue || 0) - inNext.retail);
      const inToday = intake[h.date] || { units: 0, cost: 0, retail: 0 };
      h.totals.in = inToday.units;
      h.totals.inCost = money(inToday.cost);
      h.totals.inRetail = money(inToday.retail);
      h.onhandDerived = true;
      next = h;
    }
  }

  // ---- Pass 2: per-category, same walk per category ----
  {
    const catSet = new Set(Object.keys(anchor.byCategory));
    for (const h of pre) for (const c of Object.keys(h.byCategory)) catSet.add(c);
    for (const day of Object.values(intake)) for (const c of Object.keys(day.byCategory || {})) catSet.add(c);
    const zeroSold = () => ({ onhand: null, cost: null, retail: null, in: null, inCost: 0, inRetail: 0, out: 0, soldCost: 0, soldRevenue: 0 });
    for (const cat of catSet) {
      // anchor values for a category absent at anchor = zero on hand
      let next = anchor;
      let nextVals = anchor.byCategory[cat] || { onhand: 0, cost: 0, retail: 0 };
      for (let i = anchorIdx - 1; i >= 0; i--) {
        const h = history[i];
        const nextSold = next.byCategory[cat] || zeroSold();
        const inNextC = ((intake[next.date] || {}).byCategory || {})[cat] || { units: 0, cost: 0, retail: 0 };
        const cur = (h.byCategory[cat] = h.byCategory[cat] || zeroSold());
        cur.onhand = (nextVals.onhand || 0) + (nextSold.out || 0) - inNextC.units;
        cur.cost = money((nextVals.cost || 0) + (nextSold.soldCost || 0) - inNextC.cost);
        cur.retail = money((nextVals.retail || 0) + (nextSold.soldRevenue || 0) - inNextC.retail);
        const inTodayC = ((intake[h.date] || {}).byCategory || {})[cat] || { units: 0, cost: 0, retail: 0 };
        cur.in = inTodayC.units;
        cur.inCost = money(inTodayC.cost);
        cur.inRetail = money(inTodayC.retail);
        next = h; nextVals = cur;
      }
    }
    for (const h of pre) { h.catDerived = true; h.deriveV = DERIVE_V; }
  }

  const first = history[0];
  if (first.totals.cost < 0 || first.totals.onhand < 0) {
    console.error(`WARNING: derived history went negative at ${first.date} (onhand ${first.totals.onhand}, cost ${first.totals.cost}). Raw-intake approximation likely off - flag for review.`);
  }
  return pending.length;
}

/* ---------- Run ---------- */
(async () => {
  const win = yesterdayWindow();
  console.error(`Pulling for ${win.day} (${TZ})...`);
  const p = await pullProducts(win);
  const s = await pullSold(win);

  const records = [...recs.values()].sort((a, b) =>
    a.category.localeCompare(b.category) || a.subject.localeCompare(b.subject) ||
    a.cond.localeCompare(b.cond) || a.tier.localeCompare(b.tier));

  // ---- History: carry forward, backfill missing days, upsert today ----
  let history = [];
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (Array.isArray(prev.history)) history = prev.history;
    // Carry prior anomalies forward (dedupe on date+subject+price, keep last 50).
    if (Array.isArray(prev.anomalies)) {
      const seen = new Set(anomalies.map((a) => `${a.date}|${a.subject}|${a.price}`));
      for (const a of prev.anomalies) {
        const k = `${a.date}|${a.subject}|${a.price}`;
        if (!seen.has(k)) { anomalies.push(a); seen.add(k); }
      }
      anomalies.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      anomalies.splice(0, Math.max(0, anomalies.length - 50));
    }
  } catch { /* first run or unreadable - start fresh */ }
  const have = new Set(history.map((h) => h.date));

  // Backfill sold-side for any missing day from HISTORY_BACKFILL_START to yesterday-of-window
  const missing = dateRange(HISTORY_BACKFILL_START, win.day).filter((d) => !have.has(d)).slice(0, BACKFILL_MAX_PER_RUN);
  for (const day of missing) {
    console.error(`Backfilling sold-side for ${day}...`);
    const { totals, byCategory } = await soldSummaryForDay(day);
    history.push({ date: day, onhandKnown: false, totals, byCategory });
    await sleep(400); // be polite to the API across a long backfill
  }

  // Upsert today's full entry (on-hand + sold) from the live records
  const todayRollup = rollupRecords(records);
  history = history.filter((h) => h.date !== win.day);
  history.push({ date: win.day, onhandKnown: true, totals: todayRollup.totals, byCategory: todayRollup.byCategory });
  history.sort((a, b) => a.date.localeCompare(b.date));

  // ---- Buy-side dollars backfill ----
  // Days pulled live before inCost existed carry units but no purchase cost.
  // intakeByDay already buckets cost/retail by creation day, so one range query
  // fills every gap. Idempotent: only days missing inCost are touched.
  {
    const needing = history.filter((h) => h.totals.inCost == null);
    if (needing.length) {
      const from = needing[0].date, through = needing[needing.length - 1].date;
      const dayAfter = (() => { const d = new Date(`${through}T00:00:00`); d.setDate(d.getDate() + 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
      console.error(`Backfilling buy-side dollars ${from} -> ${through} (${needing.length} day(s))...`);
      const { days: intake } = await intakeByDay(from, dayAfter);
      for (const h of needing) {
        const day = intake[h.date] || { units: 0, cost: 0, retail: 0, byCategory: {} };
        h.totals.inCost = money(day.cost);
        h.totals.inRetail = money(day.retail);
        for (const [cat, v] of Object.entries(day.byCategory || {})) {
          const c = h.byCategory[cat];
          if (c) { c.inCost = money(v.cost); c.inRetail = money(v.retail); }
        }
        for (const c of Object.values(h.byCategory)) {
          if (c.inCost == null) { c.inCost = 0; c.inRetail = 0; }
        }
      }
    }
  }

  // ---- One-time sold-side repair ----
  // 2026-07-07: a graded Pokemon single carried a corrupt 12-digit catalog price,
  // inflating that day's sold revenue to ~$175B. Recompute the day's sold-side from
  // orders using the fixed pricing (actual charged amount + sanity cap) and merge
  // into the existing entry, preserving on-hand fields. Idempotent via soldRepairedAt.
  const REPAIR_DATES = ["2026-07-07"];
  for (const day of REPAIR_DATES) {
    const h = history.find((x) => x.date === day);
    if (!h || h.soldRepairedAt) continue;
    console.error(`Repairing sold-side for ${day}...`);
    const fixed = await soldSummaryForDay(day);
    h.totals.out = fixed.totals.out;
    h.totals.soldCost = fixed.totals.soldCost;
    h.totals.soldRevenue = fixed.totals.soldRevenue;
    for (const [cat, v] of Object.entries(fixed.byCategory)) {
      const c = (h.byCategory[cat] = h.byCategory[cat] ||
        { onhand: null, cost: null, retail: null, in: null, out: 0, soldCost: 0, soldRevenue: 0 });
      c.out = v.out; c.soldCost = v.soldCost; c.soldRevenue = v.soldRevenue;
    }
    h.soldRepairedAt = new Date().toISOString();
    // Patch the day's snapshot so the rewind view reconciles: each corrupted bucket
    // gets the exact remainder of its category's repaired revenue after the clean
    // buckets in that category are summed (exact when one bucket per category is bad).
    const snapPath = path.join(SNAP_DIR, `${day}.json`);
    if (fs.existsSync(snapPath)) {
      const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
      const badRecs = snap.records.filter((r) => (r.p.daily.soldRevenue || 0) > MAX_UNIT_PRICE);
      for (const r of badRecs) {
        const cleanSum = snap.records
          .filter((x) => x.category === r.category && x !== r && (x.p.daily.soldRevenue || 0) <= MAX_UNIT_PRICE)
          .reduce((a, x) => a + (x.p.daily.soldRevenue || 0), 0);
        const catTotal = (fixed.byCategory[r.category] || { soldRevenue: 0 }).soldRevenue;
        r.p.daily.soldRevenue = money(Math.max(0, catTotal - cleanSum));
      }
      snap.totals.out = fixed.totals.out;
      snap.totals.soldCost = fixed.totals.soldCost;
      snap.totals.soldRevenue = fixed.totals.soldRevenue;
      snap.soldRepairedAt = h.soldRepairedAt;
      fs.writeFileSync(snapPath, JSON.stringify(snap));
    }
  }

  // Derive on-hand values for pre-anchor days (one-time; idempotent)
  const derived = await deriveOnhandHistory(history);
  if (derived > 0) console.error(`Derived on-hand values for ${derived} historical days.`);

  // ---- Full daily snapshot: persist today's per-item records so the dashboard can rewind ----
  // Each day is written once as its own file, keeping data.json lean and daily git diffs small.
  // Snapshots accumulate going forward only - past per-item detail cannot be reconstructed.
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SNAP_DIR, `${win.day}.json`),
    JSON.stringify({
      date: win.day,
      generatedAt: new Date().toISOString(),
      scope: "Cards only - all channels (online + POS)",
      totals: todayRollup.totals,
      records,
    })
  );
  // Available snapshot dates = every YYYY-MM-DD.json present in the snapshots dir.
  const snapshots = fs.readdirSync(SNAP_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();

  const out = {
    date: win.day,
    generatedAt: new Date().toISOString(),
    scope: "Cards only - all channels (online + POS)",
    isSample: false,
    records,
    history,
    snapshots,
    anomalies,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const tot = records.reduce((a, r) => (
    a.onhand += r.onhand, a.cost += r.val.cost, a.retail += r.val.retail,
    a.in += r.p.daily.in, a.out += r.p.daily.out,
    a.soldCost += r.p.daily.soldCost, a.soldRev += r.p.daily.soldRevenue, a
  ), { onhand: 0, cost: 0, retail: 0, in: 0, out: 0, soldCost: 0, soldRev: 0 });
  const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
  console.error(`Done. ${p.products} card products across ${p.pages} pages, ${s.orders} orders / ${s.units} units sold.`);
  console.error(`On hand -> ${tot.onhand} units | cost ${usd(tot.cost)} | retail ${usd(tot.retail)} | margin ${usd(tot.retail - tot.cost)}`);
  console.error(`Yesterday -> in ${tot.in}, out ${tot.out} | sold revenue ${usd(tot.soldRev)} | sold cost ${usd(tot.soldCost)} | sold margin ${usd(tot.soldRev - tot.soldCost)}`);
  console.error(`Wrote ${records.length} buckets to ${OUT}`);
  console.error(`History: ${history.length} days (${history[0].date} -> ${history[history.length - 1].date}), backfilled ${missing.length} this run.`);
  console.error(`Snapshots: wrote ${win.day}.json (${records.length} buckets); ${snapshots.length} day(s) available (${snapshots[0]} -> ${snapshots[snapshots.length - 1]}).`);
  if (anomalies.length) console.error(`ANOMALIES (${anomalies.length}): ${JSON.stringify(anomalies.slice(-5))}`);
})().catch((e) => { console.error(e); process.exit(1); });
