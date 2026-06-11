// `bun run stats`: P&L, API costs, rule hit rate, uptime at a glance.

import { config } from "../config.ts";
import { getDb } from "../db.ts";
import { initialCapital, isKillSwitchActive } from "../executor.ts";
import { todayET } from "../market.ts";

const db = getDb();
const capital = initialCapital(db);
const latest = db.latestSnapshot();
const today = todayET();

const equity = latest?.equity_usd ?? null;
const totalPnl = equity !== null ? equity - capital : null;
const totalPnlPct = totalPnl !== null ? (totalPnl / capital) * 100 : null;
const benchmark = latest?.benchmark_equity_usd ?? null;

console.log("=== Wallbit Trading Agent: stats ===\n");
console.log(`Mode:            ${config.executionMode}`);
console.log(`Kill switch:     ${isKillSwitchActive(db) ? "ACTIVE (frozen!)" : "off"}`);
console.log(`Initial capital: $${capital.toFixed(2)}`);
console.log(`Equity:          ${equity === null ? "n/a (no snapshots yet)" : `$${equity.toFixed(2)}`}`);
console.log(
  `Total P&L:       ${totalPnl === null ? "n/a" : `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} (${totalPnlPct!.toFixed(2)}%)`}`,
);
console.log(`SPY benchmark:   ${benchmark === null ? "n/a" : `$${benchmark.toFixed(2)} (${(((benchmark - capital) / capital) * 100).toFixed(2)}%)`}`);
if (equity !== null && benchmark !== null) {
  console.log(`Alpha vs SPY:    ${equity - benchmark >= 0 ? "+" : ""}$${(equity - benchmark).toFixed(2)}`);
}

console.log("\n--- Daily P&L (last 10 closes) ---");
for (const s of db.dailyCloseSnapshots(10)) {
  const pct = s.day_pnl_pct === null ? "?" : `${(s.day_pnl_pct * 100).toFixed(2)}%`;
  console.log(`${s.date}  equity $${s.equity_usd.toFixed(2)}  day ${pct}`);
}

console.log("\n--- Open positions ---");
const positions = db.allPositions();
if (positions.length === 0) console.log("none");
for (const p of positions) {
  console.log(`${p.ticker}  ${p.shares.toFixed(6)} sh  avg $${p.avg_cost.toFixed(2)}  basis $${p.cost_basis.toFixed(2)}`);
}

console.log("\n--- Rules (last 30 days) ---");
const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const stats = db.ruleStats(since);
const byStatus = Object.fromEntries(stats.map((s) => [s.status, s.n]));
console.log(`triggered: ${byStatus.triggered ?? 0}  expired: ${byStatus.expired ?? 0}  cancelled: ${byStatus.cancelled ?? 0}  active: ${byStatus.active ?? 0}`);

const realized = db.realizedTrades(200);
const wins = realized.filter((t) => t.pnl_usd > 0).length;
console.log(`\n--- Realized trades ---`);
console.log(`count: ${realized.length}  wins: ${wins}  hit rate: ${realized.length > 0 ? ((wins / realized.length) * 100).toFixed(1) + "%" : "n/a"}`);
console.log(`realized P&L total: $${db.realizedPnlSince("1970-01-01").toFixed(2)}`);

console.log("\n--- API costs ---");
console.log(`total: $${db.totalApiCost().toFixed(2)}   today: $${db.apiCostForDate(today).toFixed(2)}`);

console.log("\n--- Uptime ---");
const hb = db.getHeartbeat();
console.log(`last heartbeat: ${hb ?? "never"}${hb ? ` (${((Date.now() - Date.parse(hb)) / 60000).toFixed(1)} min ago)` : ""}`);
const gaps = db.recentEvents(500).filter((e) => e.type === "gap" || e.type === "restart");
console.log(`restarts/gaps logged (recent): ${gaps.length}`);
