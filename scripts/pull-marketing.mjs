#!/usr/bin/env node
/**
 * CardsHQ Marketing Tier Dashboard - daily pull
 * ---------------------------------------------
 * Pulls tiered products (tags "Tier 1" / "Tier 2" / "Tier 3") and quarter-to-date
 * online sales for each, plus an order-level attribution summary, and writes
 * cardshq/marketing-dashboard/data.json for the static dashboard.
 *
 * Scope: standard ecom definition - Online Store (source_name "web") +
 * CardsHQ Headless API (source_name "228418125825") only. POS, draft orders,
 * marketplaces, and Whatnot are excluded.
 *
 * Run:
 *   SHOPIFY_STORE=your-store SHOPIFY_ADMIN_TOKEN=shpat_xxx node scripts/pull-marketing.mjs
 *
 * Env:
 *   SHOPIFY_STORE         store handle or full domain
 *   SHOPIFY_ADMIN_TOKEN   Admin API access token. NEVER commit this.
 *   API_VERSION           optional, defaults to 2025-01
 *
 * Required scopes: read_products, read_orders
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const STORE = (process.env.SHOPIFY_STORE || "").replace(/\.myshopify\.com$/, "");
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.API_VERSION || "2025-01";
const OUT = process.env.OUT || path.join(REPO_ROOT, "cardshq/marketing-dashboard/data.json");
const SNAP_DIR = process.env.SNAP_DIR || path.join(REPO_ROOT, "cardshq/marketing-dashboard/snapshots");
const TZ = "America/New_York";

const HEADLESS_SOURCE = "228418125825"; // CardsHQ Headless API
const ONLINE_SOURCES = new Set(["web", HEADLESS_SOURCE]);
const TIER_TAGS = { "Tier 1": 1, "Tier 2": 2, "Tier 3": 3 };

if (!STORE || !TOKEN) {
  console.error("Missing SHOPIFY_STORE or SHOPIFY_ADMIN_TOKEN env vars.");
  process.exit(1);
}

const ENDPOINT = `https://${STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function gql(query, variables = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    if (body.errors) {
      const throttled = JSON.stringify(body.errors).includes("THROTTLED");
      if (throttled && attempt < 5) { await sleep(1500 * attempt); continue; }
      throw new Error("GraphQL error: " + JSON.stringify(body.errors));
    }
    return body.data;
  }
}

/* ---------- Dates: today + quarter start in store TZ ---------- */
function etParts(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
}
const today = etParts();
const todayStr = `${today.year}-${today.month}-${today.day}`;
const qStartMonth = String(Math.floor((Number(today.month) - 1) / 3) * 3 + 1).padStart(2, "0");
const quarterStart = `${today.year}-${qStartMonth}-01`;
const quarterLabel = `Q${Math.floor((Number(today.month) - 1) / 3) + 1} ${today.year}`;

/* ---------- 1. Tiered products ---------- */
async function fetchTieredProducts() {
  const products = new Map(); // numeric id -> record
  for (const [tag, tier] of Object.entries(TIER_TAGS)) {
    let after = null;
    do {
      const data = await gql(
        `query($q: String!, $after: String) {
          products(first: 50, after: $after, query: $q) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id title handle vendor productType status
              featuredMedia { preview { image { url(transform: {maxWidth: 120}) } } }
              priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
              totalInventory
            }
          }
        }`,
        { q: `tag:"${tag}"`, after }
      );
      for (const p of data.products.nodes) {
        const numId = p.id.split("/").pop();
        products.set(numId, {
          id: numId, title: p.title, handle: p.handle, tier,
          vendor: p.vendor || "", productType: p.productType || "",
          status: p.status,
          image: p.featuredMedia?.preview?.image?.url || null,
          price: money(p.priceRangeV2?.maxVariantPrice?.amount),
          onhand: p.totalInventory ?? 0,
          unitsSold: 0, revenue: 0, orders: 0,
          daily: {}, // "YYYY-MM-DD" -> { units, rev }
        });
      }
      after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (after);
  }
  return products;
}

/* ---------- 2. QTD online orders: sales + attribution ---------- */
async function fetchOrders(products) {
  const attribution = {
    onlineOrders: 0, ordersWithUtm: 0,
    channels: new Map(), // label -> { orders, revenue }
  };
  const tier4 = { revenue: 0, unitsSold: 0, orders: 0 };

  let after = null;
  do {
    const data = await gql(
      `query($q: String!, $after: String) {
        orders(first: 100, after: $after, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id createdAt sourceName test
            currentTotalPriceSet { shopMoney { amount } }
            customerJourneySummary {
              firstVisit { source referrerUrl utmParameters { source medium campaign } }
              lastVisit { source referrerUrl utmParameters { source medium campaign } }
            }
            lineItems(first: 50) {
              nodes {
                quantity
                discountedTotalSet { shopMoney { amount } }
                product { id }
              }
            }
          }
        }
      }`,
      { q: `created_at:>='${quarterStart}' AND NOT source_name:pos`, after }
    );

    for (const o of data.orders.nodes) {
      if (o.test) continue;
      if (!ONLINE_SOURCES.has(String(o.sourceName))) continue; // locked ecom definition
      attribution.onlineOrders += 1;
      const day = o.createdAt.slice(0, 10);

      // Attribution channel (last-click, falling back to first visit)
      const visit = o.customerJourneySummary?.lastVisit || o.customerJourneySummary?.firstVisit || null;
      const utm = visit?.utmParameters || null;
      if (utm && (utm.source || utm.campaign)) attribution.ordersWithUtm += 1;
      let label = "Direct / unknown";
      if (utm && (utm.source || utm.campaign)) {
        label = `${utm.source || "utm"}${utm.campaign ? " / " + utm.campaign : ""}`;
      } else if (visit?.source && visit.source !== "direct" && !String(visit.source).includes("cardshq.com")) {
        label = `${visit.source} (referrer only)`;
      }
      const ch = attribution.channels.get(label) || { orders: 0, revenue: 0 };
      ch.orders += 1;
      ch.revenue = money(ch.revenue + Number(o.currentTotalPriceSet?.shopMoney?.amount || 0));
      attribution.channels.set(label, ch);

      // Line items -> tiered products or tier 4 aggregate
      let touchedTiered = false;
      for (const li of o.lineItems.nodes) {
        const pid = li.product?.id?.split("/").pop();
        const rev = money(li.discountedTotalSet?.shopMoney?.amount);
        if (pid && products.has(pid)) {
          const rec = products.get(pid);
          rec.unitsSold += li.quantity;
          rec.revenue = money(rec.revenue + rev);
          const d = rec.daily[day] || { units: 0, rev: 0 };
          d.units += li.quantity; d.rev = money(d.rev + rev);
          rec.daily[day] = d;
          touchedTiered = true;
        } else {
          tier4.revenue = money(tier4.revenue + rev);
          tier4.unitsSold += li.quantity;
        }
      }
      if (touchedTiered) {
        for (const li of o.lineItems.nodes) {
          const pid = li.product?.id?.split("/").pop();
          if (pid && products.has(pid)) { products.get(pid).orders += 1; break; }
        }
      } else {
        tier4.orders += 1;
      }
    }
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);

  return { attribution, tier4 };
}

/* ---------- Main ---------- */
const products = await fetchTieredProducts();
console.log(`Tiered products found: ${products.size}`);
const { attribution, tier4 } = await fetchOrders(products);

const payload = {
  date: todayStr,
  generatedAt: new Date().toISOString(),
  quarter: quarterLabel,
  quarterStart,
  scope: "Online Store + CardsHQ Headless API (locked ecom definition)",
  isSample: false,
  products: [...products.values()].sort((a, b) => a.tier - b.tier || b.revenue - a.revenue),
  tier4,
  attribution: {
    onlineOrders: attribution.onlineOrders,
    ordersWithUtm: attribution.ordersWithUtm,
    utmCoverage: attribution.onlineOrders
      ? Math.round((attribution.ordersWithUtm / attribution.onlineOrders) * 1000) / 10
      : 0,
    channels: [...attribution.channels.entries()]
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 12),
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
fs.mkdirSync(SNAP_DIR, { recursive: true });
fs.writeFileSync(path.join(SNAP_DIR, `${todayStr}.json`), JSON.stringify(payload, null, 1));
console.log(`Wrote ${OUT} (${payload.products.length} tiered products, ${payload.attribution.onlineOrders} online orders QTD)`);
