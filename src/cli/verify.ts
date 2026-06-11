// `bun run verify [--init]`
// Read-only check of the Wallbit API with the real account, plus a price
// freshness comparison (Wallbit asset price vs Yahoo) to decide PRICE_SOURCE.
// --init: capture initial capital + benchmark baseline and reconcile positions.

import { getDb } from "../db.ts";
import { getQuote } from "../prices.ts";
import { wallbit } from "../wallbit.ts";

const doInit = process.argv.includes("--init");
const db = getDb();

if (!wallbit.hasKey) {
  console.error("WALLBIT_API_KEY not set in .env. Add it and rerun. (Dry-run works without it.)");
  process.exit(1);
}

console.log("1) Checking balance endpoints...");
const checking = await wallbit.getCheckingBalance();
console.log("   checking:", checking);
const stocks = await wallbit.getStocksBalance();
console.log("   investment portfolio:", stocks);
const cash = stocks.find((h) => h.symbol === "USD")?.shares ?? 0;

console.log("\n2) Assets catalog...");
const sample = await wallbit.listAssets({ limit: 5 });
console.log(`   ${sample.count} assets in catalog. Sample:`, sample.data.map((a) => `${a.symbol} $${a.price}`).join(", "));

console.log("\n3) Fees (TRADE)...");
try {
  console.log("   ", JSON.stringify(await wallbit.getFees()).slice(0, 300));
} catch (err) {
  console.log("   fees endpoint failed (non-fatal):", String(err));
}

console.log("\n4) Price freshness: Wallbit vs Yahoo (3 samples, ~90s)...");
const symbols = ["SPY", "NVDA", "AAPL"];
for (let i = 0; i < 3; i++) {
  for (const s of symbols) {
    const [wb, yh] = await Promise.all([wallbit.getAsset(s), getQuote(s)]);
    const diff = wb && yh ? (((wb.price - yh.price) / yh.price) * 100).toFixed(3) : "?";
    console.log(`   ${s}: wallbit $${wb?.price ?? "?"} | yahoo $${yh?.price?.toFixed(2) ?? "?"} | diff ${diff}%`);
  }
  if (i < 2) {
    console.log("   ...waiting 45s...");
    await new Promise((r) => setTimeout(r, 45_000));
  }
}
console.log("   If Wallbit prices did not move across samples during market hours, keep PRICE_SOURCE=yahoo.");

if (doInit) {
  console.log("\n5) Initializing account baseline...");
  const holdings = stocks.filter((h) => h.symbol !== "USD");
  let positionsValue = 0;
  const rows: { ticker: string; shares: number; avgCost: number }[] = [];
  for (const h of holdings) {
    const q = await getQuote(h.symbol);
    const price = q?.price ?? 0;
    positionsValue += h.shares * price;
    rows.push({ ticker: h.symbol, shares: h.shares, avgCost: price });
  }
  const capital = cash + positionsValue;
  db.setMeta("initial_capital", String(capital));
  db.replacePositions(rows);
  const spy = await getQuote("SPY");
  if (spy) db.setMeta("benchmark_initial_price", String(spy.price));
  console.log(`   initial_capital = $${capital.toFixed(2)} (cash $${cash.toFixed(2)} + positions $${positionsValue.toFixed(2)})`);
  console.log(`   benchmark baseline SPY = $${spy?.price?.toFixed(2) ?? "?"}`);
  console.log("   positions table reconciled with broker.");
}

console.log("\nDone.");
