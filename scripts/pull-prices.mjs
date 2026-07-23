#!/usr/bin/env node
/**
 * CardsHQ TCG Price-Change Dashboard - price pull
 * -----------------------------------------------
 * Scope: all ACTIVE products tagged "Pokemon Boxes" (sealed Pokemon).
 * Each run snapshots every variant's price and diffs against the previous
 * snapshot. Any price movement is appended to changes.json with old price,
 * new price, delta, and detection timestamp.
 *
 * Outputs (publish dir of the price dashboard Netlify site):
 *   cardshq/price-dashboard/data/latest.json   - current full price snapshot
 *   cardshq/price-dashboard/data/changes.json  - append-only price change log
 *
 * Run:
 *   SHOPIFY_STORE=cardshq SHOPIFY_ADMIN_TOKEN=shpat_xxx node scripts/pull-prices.mjs
 *
 * Notes:
 *   - Matching is by variant GID (stable), never by title.
 *   - First run seeds latest.json with zero changes; history accrues forward.
 *   - Detection time is when the job saw the change, not the exact minute the
 *     price was edited in admin. At 4 runs/day the gap is at most ~6 hours.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const STORE = (process.env.SHOPIFY_STORE || "").replace(/\.myshopify\.com$/, "");
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.API_VERSION || "2025-01";
const DATA_DIR = process.env.DATA_DIR || path.join(REPO_ROOT, "cardshq/price-dashboard/data");
const SCOPE_QUERY = "tag:'Pokemon Boxes' AND status:active";
const MAX_CHANGE_ENTRIES = 5000; // keep the log bounded; ~6+ months at heavy repricing

if (!STORE || !TOKEN) {
  console.error("Missing SHOPIFY_STORE or SHOPIFY_ADMIN_TOKEN env vars.");
  process.exit(1);
}

const ENDPOINT = `https://${STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
      continue;
    }
    const json = await res.json();
    if (json.errors) {
      const throttled = json.errors.some((e) => e?.extensions?.code === "THROTTLED");
      if (throttled && attempt < 5) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      throw new Error("GraphQL errors: " + JSON.stringify(json.errors));
    }
    return json.data;
  }
  throw new Error("Shopify API retries exhausted");
}

const PRODUCTS_QUERY = `
  query PokePrices($after: String, $q: String!) {
    products(first: 100, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        tags
        variants(first: 100) {
          nodes { id title sku price inventoryQuantity }
        }
      }
    }
  }
`;

async function pullSnapshot() {
  const products = [];
  let after = null;
  let pages = 0;
  for (;;) {
    const data = await gql(PRODUCTS_QUERY, { after, q: SCOPE_QUERY });
    const conn = data.products;
    for (const p of conn.nodes) {
      products.push({
        id: p.id,
        title: p.title,
        jp: p.tags.includes("Japanese Pokemon Boxes"),
        variants: p.variants.nodes.map((v) => ({
          id: v.id,
          title: v.title === "Default Title" ? "" : v.title,
          sku: v.sku || "",
          price: v.price,
          inv: v.inventoryQuantity ?? 0,
        })),
      });
    }
    pages++;
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    if (pages > 60) throw new Error("Pagination runaway - aborting");
  }
  return products;
}

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

const now = new Date().toISOString();
const latestPath = path.join(DATA_DIR, "latest.json");
const changesPath = path.join(DATA_DIR, "changes.json");

const previous = loadJSON(latestPath, null);
const changeLog = loadJSON(changesPath, { changes: [] });

const products = await pullSnapshot();
const variantCount = products.reduce((s, p) => s + p.variants.length, 0);
console.log(`Pulled ${products.length} products / ${variantCount} variants.`);

let newChanges = 0;
if (previous && Array.isArray(previous.products)) {
  const prevByVariant = new Map();
  for (const p of previous.products) {
    for (const v of p.variants) prevByVariant.set(v.id, { product: p, variant: v });
  }
  for (const p of products) {
    for (const v of p.variants) {
      const prev = prevByVariant.get(v.id);
      if (!prev) continue; // brand-new variant: no old price to compare
      const oldP = num(prev.variant.price);
      const newP = num(v.price);
      if (oldP === null || newP === null || oldP === newP) continue;
      changeLog.changes.push({
        productId: p.id,
        product: p.title,
        variant: v.title,
        sku: v.sku,
        jp: p.jp,
        old: oldP,
        new: newP,
        delta: Math.round((newP - oldP) * 100) / 100,
        inv: v.inv,
        at: now,
      });
      newChanges++;
    }
  }
} else {
  console.log("No previous snapshot - seeding baseline, no changes recorded.");
}

changeLog.changes.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
if (changeLog.changes.length > MAX_CHANGE_ENTRIES) {
  changeLog.changes.length = MAX_CHANGE_ENTRIES;
}
changeLog.generatedAt = now;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(
  latestPath,
  JSON.stringify({ generatedAt: now, scope: SCOPE_QUERY, products }),
);
fs.writeFileSync(changesPath, JSON.stringify(changeLog));
console.log(`Detected ${newChanges} price change(s). Log size: ${changeLog.changes.length}.`);
