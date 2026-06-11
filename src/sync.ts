// One-way, best-effort push of public dashboard data to Supabase.
// SQLite on the Mac remains the single source of truth; if Supabase or
// Vercel are down, trading is unaffected.

import { config } from "./config.ts";
import { getDb, type Db } from "./db.ts";
import { initialCapital, isKillSwitchActive } from "./executor.ts";
import { log } from "./log.ts";
import { todayET } from "./market.ts";
import { getQuotes } from "./prices.ts";

function enabled(): boolean {
  return config.supabaseUrl.length > 0 && config.supabaseServiceKey.length > 0;
}

async function upsert(table: string, rows: unknown[], conflict: string): Promise<boolean> {
  if (rows.length === 0) return true;
  const url = `${config.supabaseUrl}/rest/v1/${table}?on_conflict=${conflict}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          apikey: config.supabaseServiceKey,
          Authorization: `Bearer ${config.supabaseServiceKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(rows),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return true;
      log.warn(`supabase upsert ${table} -> ${res.status}`, { body: (await res.text()).slice(0, 200) });
    } catch (err) {
      log.warn(`supabase upsert ${table} failed (attempt ${attempt + 1})`, { err: String(err) });
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return false;
}

export async function syncToSupabase(db: Db = getDb()): Promise<void> {
  if (!enabled()) return;
  const started = Date.now();
  try {
    const lastSyncTs = db.getMeta("last_sync_ts") ?? "1970-01-01T00:00:00Z";

    // Equity snapshots (incremental)
    const snapshots = db.snapshotsSince(lastSyncTs).map((s) => ({
      id: s.id,
      ts: s.ts,
      date: s.date,
      equity_usd: s.equity_usd,
      cash_usd: s.cash_usd,
      invested_usd: s.invested_usd,
      benchmark_equity_usd: s.benchmark_equity_usd,
      day_pnl_pct: s.day_pnl_pct,
    }));

    // Current positions enriched with last known price for public P&L display.
    const positionRows = db.allPositions();
    const quotes = positionRows.length > 0 ? await getQuotes(positionRows.map((p) => p.ticker)).catch(() => new Map()) : new Map();
    const positions = positionRows.map((p) => {
      const price = quotes.get(p.ticker)?.price ?? null;
      const value = price !== null ? p.shares * price : null;
      return {
        ticker: p.ticker,
        shares: p.shares,
        avg_cost: p.avg_cost,
        cost_basis: p.cost_basis,
        last_price: price,
        market_value: value,
        pnl_usd: value !== null ? value - p.cost_basis : null,
        stop_loss: p.stop_loss_json,
        take_profit: p.take_profit_json,
        opened_at: p.opened_at,
        updated_at: p.updated_at,
      };
    });

    const orders = db.recentOrders(100).map((o) => {
      const rule = o.rule_id ? db.ruleById(o.rule_id) : null;
      return {
        id: o.id,
        ts: o.requested_at,
        ticker: o.ticker,
        side: o.side,
        mode: o.mode,
        status: o.status,
        req_amount_usd: o.req_amount_usd,
        fill_price: o.fill_price,
        fill_shares: o.fill_shares,
        fill_usd: o.fill_usd,
        rule_id: o.rule_id,
        reason: rule?.reason ?? null,
      };
    });

    const journal = db.recentJournal(50).map((j) => ({
      id: `${j.created_at}|${j.type}`,
      date: j.date,
      type: j.type,
      content: j.content,
      created_at: j.created_at,
    }));

    const today = todayET();
    const plan = db.latestPlan(today) ?? db.planForDate(today);
    const latest = db.latestSnapshot();
    const status = [
      {
        id: 1,
        updated_at: new Date().toISOString(),
        mode: config.executionMode,
        initial_capital: initialCapital(db),
        equity_usd: latest?.equity_usd ?? null,
        benchmark_equity_usd: latest?.benchmark_equity_usd ?? null,
        kill_switch: isKillSwitchActive(db),
        thesis: plan?.thesis ?? null,
        thesis_date: plan ? today : null,
        api_cost_total_usd: db.totalApiCost(),
        realized_pnl_usd: db.realizedPnlSince("1970-01-01"),
      },
    ];

    // Remove closed positions from the public mirror.
    try {
      const current = positions.map((p) => `"${p.ticker}"`).join(",");
      const filter = positions.length > 0 ? `?ticker=not.in.(${current})` : "";
      await fetch(`${config.supabaseUrl}/rest/v1/positions${filter}`, {
        method: "DELETE",
        headers: {
          apikey: config.supabaseServiceKey,
          Authorization: `Bearer ${config.supabaseServiceKey}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      log.warn("supabase stale position cleanup failed", { err: String(err) });
    }

    const ok = await Promise.all([
      upsert("snapshots", snapshots, "id"),
      upsert("positions", positions, "ticker"),
      upsert("trades", orders, "id"),
      upsert("journal", journal, "id"),
      upsert("agent_status", status, "id"),
    ]);
    if (ok.every(Boolean)) {
      db.setMeta("last_sync_ts", new Date().toISOString());
      log.info("supabase sync ok", { ms: Date.now() - started, snapshots: snapshots.length });
    }
  } catch (err) {
    log.warn("supabase sync failed", { err: String(err) });
  }
}
