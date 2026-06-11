// Core agent logic, callable either as a long-running loop (src/index.ts) or
// as a single one-shot tick (src/tick.ts on GitHub Actions cron). No top-level
// side effects beyond opening the DB, so it is safe to import after the state
// file has been restored from storage.

import { config } from "./config.ts";
import { createBroker, LiveBroker, NotifyBroker } from "./broker.ts";
import { getDb } from "./db.ts";
import { createExecutor, defaultDeps, initialCapital } from "./executor.ts";
import { cleanOldLogs, log } from "./log.ts";
import { etParts, isMarketOpen, isTradingDay, marketCloseMinutes } from "./market.ts";
import { notify } from "./notify.ts";
import { runMidday, runPlanner } from "./planner.ts";
import { getQuotes } from "./prices.ts";
import { runWeeklyReview } from "./review.ts";
import { syncToSupabase } from "./sync.ts";
import { wallbit } from "./wallbit.ts";

const PLANNER_MIN = 8 * 60 + 30; // 08:30 ET
const MIDDAY_MIN = 12 * 60 + 30; // 12:30 ET
const EOD_OFFSET_MIN = 5; // close + 5
const REVIEW_MIN = 16 * 60 + 10; // 16:10 ET Friday

const db = getDb();
const broker = createBroker();
const executor = createExecutor({ ...defaultDeps(), broker });

let lastExecutorTick = 0;
let lastSync = 0;
let running = false;

export async function bootChecks(opts: { announce?: boolean } = {}): Promise<void> {
  const announce = opts.announce ?? true;
  cleanOldLogs();
  const heartbeat = db.getHeartbeat();
  let gapNote = "first boot";
  if (heartbeat) {
    const gapMin = (Date.now() - Date.parse(heartbeat)) / 60000;
    gapNote = `last heartbeat ${gapMin.toFixed(1)} min ago`;
    if (gapMin > 10) {
      db.addEvent("gap", { gapMin });
      log.warn(`heartbeat gap detected: ${gapMin.toFixed(1)} min`);
    }
  }
  db.setHeartbeat();

  if ((config.executionMode === "live" || config.executionMode === "notify") && !wallbit.hasKey) {
    log.error(`EXECUTION_MODE=${config.executionMode} requires WALLBIT_API_KEY (read scope). Refusing to start.`);
    process.exit(1);
  }
  if (config.executionMode === "notify" && !config.webhookUrl) {
    log.warn("EXECUTION_MODE=notify without WEBHOOK_URL: signals will only appear in logs/dashboard. Set a webhook to get push notifications.");
  }

  // Live/notify: reconcile local position book against the real portfolio.
  if ((broker instanceof LiveBroker || broker instanceof NotifyBroker) && wallbit.hasKey) {
    try {
      const holdings = (await wallbit.getStocksBalance()).filter((h) => h.symbol !== "USD");
      const local = db.allPositions();
      for (const l of local) {
        if (!holdings.find((h) => h.symbol === l.ticker)) {
          log.warn(`reconcile: ${l.ticker} in DB but not at broker, removing`);
          db.sqlite.query("DELETE FROM positions WHERE ticker = ?").run(l.ticker);
        }
      }
      for (const h of holdings) {
        const l = db.getPosition(h.symbol);
        if (!l) {
          const quote = (await getQuotes([h.symbol])).get(h.symbol);
          const price = quote?.price ?? 0;
          log.warn(`reconcile: ${h.symbol} at broker but not in DB, adopting at current price`);
          db.applyBuyFill({ ticker: h.symbol, shares: h.shares, fillUsd: h.shares * price, stopLossJson: null, takeProfitJson: null, sourceRuleId: null });
        } else if (Math.abs(l.shares - h.shares) > 1e-6) {
          log.warn(`reconcile: ${h.symbol} share mismatch db=${l.shares} broker=${h.shares}, trusting broker`);
          db.sqlite.query("UPDATE positions SET shares = ?, cost_basis = avg_cost * ?, updated_at = ? WHERE ticker = ?").run(h.shares, h.shares, new Date().toISOString(), h.symbol);
        }
      }
    } catch (err) {
      log.error("live reconcile failed", { err: String(err) });
    }
  }

  if (announce) {
    await notify("restart", "Agent started", `mode=${config.executionMode.toUpperCase()}, capital=$${initialCapital(db)}, ${gapNote}`);
  }
}

async function endOfDay(date: string) {
  try {
    const positions = db.allPositions();
    const tickers = [config.benchmarkTicker, ...positions.map((p) => p.ticker)];
    const quotes = await getQuotes(tickers);
    const cash = await broker.getCash().catch(() => null);
    if (cash !== null) {
      const value = positions.reduce((acc, p) => acc + p.shares * (quotes.get(p.ticker)?.price ?? p.avg_cost), 0);
      const equity = cash + value;
      const daily = db.getDailyState(date);
      const dayPnl = daily.day_start_equity ? (equity - daily.day_start_equity) / daily.day_start_equity : null;
      const spy = quotes.get(config.benchmarkTicker)?.price ?? null;
      let benchmarkInitial = db.getMetaNum("benchmark_initial_price");
      if (benchmarkInitial === null && spy !== null) {
        benchmarkInitial = spy;
        db.setMeta("benchmark_initial_price", String(spy));
      }
      db.addSnapshot({
        date,
        equityUsd: equity,
        cashUsd: cash,
        investedUsd: value,
        positionsJson: JSON.stringify(positions.map((p) => ({ ticker: p.ticker, shares: p.shares, price: quotes.get(p.ticker)?.price ?? null }))),
        benchmarkPrice: spy,
        benchmarkEquityUsd: spy && benchmarkInitial ? initialCapital(db) * (spy / benchmarkInitial) : null,
        dayPnlPct: dayPnl,
      });
      const stats = db.ruleStats(date);
      const summary = `Cierre ${date}: equity $${equity.toFixed(2)} (${dayPnl === null ? "?" : ((dayPnl ?? 0) * 100).toFixed(2) + "%"} dia). Reglas: ${stats.map((s) => `${s.status}=${s.n}`).join(", ") || "ninguna"}. Costo API hoy: $${db.apiCostForDate(date).toFixed(2)}.`;
      db.addJournal(date, "day_close", summary);
      log.info(summary);
    }
  } catch (err) {
    log.error("endOfDay failed", { err: String(err) });
  }
  db.setDailyState(date, { closed: 1 });
  await syncToSupabase(db);
}

// One pass of the schedule. Idempotent via daily_state flags, so it is safe to
// call every 15s (loop) or every few minutes (cron) without double-running.
export async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const p = etParts(now);
    const date = p.date;
    const tradingDay = isTradingDay(p);
    const daily = db.getDailyState(date);

    // Pre-market planner
    if (tradingDay && p.minutesOfDay >= PLANNER_MIN && p.minutesOfDay < marketCloseMinutes(p) && daily.planner_ran === 0) {
      db.setDailyState(date, { planner_ran: 1 }); // claim before the slow call
      try {
        await runPlanner(db, broker);
      } catch (err) {
        log.error("planner crashed", { err: String(err) });
        await notify("planner_failed", "Planner crashed", String(err).slice(0, 300));
      }
      await syncToSupabase(db);
    }

    // Mid-day light revision
    if (
      config.middayEnabled &&
      tradingDay &&
      p.minutesOfDay >= MIDDAY_MIN &&
      isMarketOpen(now) &&
      daily.midday_ran === 0 &&
      db.getDailyState(date).planner_ran === 1
    ) {
      db.setDailyState(date, { midday_ran: 1 });
      try {
        await runMidday(db, broker);
      } catch (err) {
        log.error("midday crashed", { err: String(err) });
      }
    }

    // Executor tick
    if (isMarketOpen(now) && Date.now() - lastExecutorTick >= config.tickIntervalSec * 1000) {
      lastExecutorTick = Date.now();
      const summary = await executor.tick();
      if (summary.fired.length > 0 || summary.protectiveSells.length > 0) {
        await syncToSupabase(db);
        lastSync = Date.now();
      }
    } else if (!isMarketOpen(now)) {
      db.setHeartbeat();
    }

    // Periodic sync during market hours
    if (isMarketOpen(now) && Date.now() - lastSync >= config.syncIntervalMin * 60 * 1000) {
      lastSync = Date.now();
      await syncToSupabase(db);
    }

    // End of day
    if (tradingDay && p.minutesOfDay >= marketCloseMinutes(p) + EOD_OFFSET_MIN && daily.closed === 0) {
      await endOfDay(date);
    }

    // Weekly review (Friday after close)
    if (tradingDay && p.weekday === 5 && p.minutesOfDay >= REVIEW_MIN && daily.review_ran === 0) {
      db.setDailyState(date, { review_ran: 1 });
      try {
        await runWeeklyReview(db);
      } catch (err) {
        log.error("weekly review crashed", { err: String(err) });
      }
      await syncToSupabase(db);
    }

    // Daily API cost alert
    const costToday = db.apiCostForDate(date);
    if (costToday > config.costAlertDailyUsd && db.getMeta(`cost_alert_${date}`) !== "1") {
      db.setMeta(`cost_alert_${date}`, "1");
      await notify("cost_alert", "API cost over budget", `Hoy: $${costToday.toFixed(2)} (target < $${config.costAlertDailyUsd}). Considerar DAILY_MODEL mas barato.`);
    }
  } catch (err) {
    log.error("scheduler loop error", { err: String(err) });
  } finally {
    running = false;
  }
}
