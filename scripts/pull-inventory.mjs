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
 * Required custom-app scopes: read_products, read_orders, read_marketplace_orders, read_quick_sale
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
const TZ = "America/New_York";

if (!STORE || !TOKEN) {
  console.error("Missing SHOPIFY_STORE or SHOPIFY_ADMIN_TOKEN env vars.");
  process.exit(1);
}

const CONFIG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "cardshq/inventory-dashboard/tags.config.json"), "utf8")
);
const ENDPOINT = `https://${STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;

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
function bump(slice, field, amount) {
  const k = keyOf(slice);
  if (!recs.has(k)) recs.set(k, { category: slice.category, subject: slice.subject, tier: slice.tier, cond: slice.cond, onhand: 0, p: { daily: { in: 0, out: 0 } } });
  const rec = recs.get(k);
  if (field === "onhand") rec.onhand += amount;       // current units on hand
  else rec.p.daily[field] += amount;                  // "in" (intake) | "out" (sold), yesterday
}

/* ---------- 1) On-hand + intake from products ---------- */
const CARD_TYPE_FILTER = CONFIG.cardProductTypes.map((t) => `product_type:'${t}'`).join(" OR ");
const CARDS_QUERY = `
query Cards($cursor: String) {
  products(first: 250, after: $cursor, query: "${CARD_TYPE_FILTER}") {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id productType tags createdAt
      variants(first: 10) { edges { node { price inventoryQuantity } } }
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
      const onhand = variants.reduce((a, v) => a + (v.inventoryQuantity || 0), 0);
      const price = variants[0] ? variants[0].price : 0;
      const tier = classifyTier(price);
      const slice = { category: subj.category, subject: subj.name, cond, tier };
      if (onhand > 0) bump(slice, "onhand", onhand);
      // Intake: each single created yesterday counts as 1 unit in (one-of-one model).
      // NOTE v1 assumption: 1 unit per new single. Multi-qty intake/restocks refine later.
      if (node.createdAt >= toISO(win.start) && node.createdAt < toISO(win.end)) bump(slice, "in", 1);
      products++;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
  } while (cursor);
  return { pages, products };
}
const toISO = (local) => new Date(local).toISOString();

/* ---------- 2) Sold yesterday from orders ---------- */
const SOLD_QUERY = `
query Sold($cursor: String, $q: String!) {
  orders(first: 100, after: $cursor, query: $q) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id
      lineItems(first: 100) { edges { node {
        quantity
        product { productType tags }
        variant { price }
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
        const tier = classifyTier(li.variant ? li.variant.price : 0);
        bump({ category: subj.category, subject: subj.name, cond, tier }, "out", li.quantity || 0);
        units += li.quantity || 0;
      }
      orders++;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return { orders, units };
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

  const out = {
    date: win.day,
    generatedAt: new Date().toISOString(),
    scope: "Cards only - all channels (online + POS)",
    isSample: false,
    records,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const tot = records.reduce((a, r) => (a.onhand += r.onhand, a.in += r.p.daily.in, a.out += r.p.daily.out, a), { onhand: 0, in: 0, out: 0 });
  console.error(`Done. ${p.products} card products across ${p.pages} pages, ${s.orders} orders / ${s.units} units sold.`);
  console.error(`Totals -> on hand ${tot.onhand}, in ${tot.in}, out ${tot.out}. Wrote ${records.length} buckets to ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
