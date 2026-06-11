import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

// Kept as standalone DDL so the migration below can rebuild old tables
// when new enum values are added to the CHECK constraints.
const RULES_DDL = `(
  id TEXT PRIMARY KEY,
  plan_id INTEGER,
  date TEXT NOT NULL,
  ticker TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('buy','sell')),
  kind TEXT NOT NULL CHECK (kind IN ('entry','exit','protective')),
  trigger_json TEXT NOT NULL,
  amount_usd REAL,
  valid_until TEXT NOT NULL,
  stop_loss_json TEXT,
  take_profit_json TEXT,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','triggered','expired','cancelled','missed')),
  triggered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

const ORDERS_DDL = `(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  req_amount_usd REAL,
  req_shares REAL,
  mode TEXT NOT NULL CHECK (mode IN ('live','dry','notify')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','filled','failed','unverified','awaiting_manual','missed')),
  wallbit_json TEXT,
  error TEXT,
  fill_price REAL,
  fill_shares REAL,
  fill_usd REAL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  verified_at TEXT
)`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('premarket','midday','fallback')),
  thesis TEXT NOT NULL DEFAULT '',
  json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','failed','superseded')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS rules ${RULES_DDL};
CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status);
CREATE INDEX IF NOT EXISTS idx_rules_date ON rules(date);

CREATE TABLE IF NOT EXISTS orders ${ORDERS_DDL};
CREATE INDEX IF NOT EXISTS idx_orders_requested ON orders(requested_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS positions (
  ticker TEXT PRIMARY KEY,
  shares REAL NOT NULL,
  avg_cost REAL NOT NULL,
  cost_basis REAL NOT NULL,
  stop_loss_json TEXT,
  take_profit_json TEXT,
  source_rule_id TEXT,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS realized_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  shares REAL NOT NULL,
  proceeds_usd REAL NOT NULL,
  cost_usd REAL NOT NULL,
  pnl_usd REAL NOT NULL,
  rule_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  opened_at TEXT,
  closed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('plan','midday','review','event','day_close')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_journal_date ON journal(date);

CREATE TABLE IF NOT EXISTS api_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  date TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  date TEXT NOT NULL,
  equity_usd REAL NOT NULL,
  cash_usd REAL NOT NULL,
  invested_usd REAL NOT NULL,
  positions_json TEXT NOT NULL,
  benchmark_price REAL,
  benchmark_equity_usd REAL,
  day_pnl_pct REAL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON equity_snapshots(ts);

CREATE TABLE IF NOT EXISTS daily_state (
  date TEXT PRIMARY KEY,
  day_start_equity REAL,
  orders_count INTEGER NOT NULL DEFAULT 0,
  buys_frozen INTEGER NOT NULL DEFAULT 0,
  planner_ran INTEGER NOT NULL DEFAULT 0,
  midday_ran INTEGER NOT NULL DEFAULT 0,
  review_ran INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
`;

export interface RuleRow {
  id: string;
  plan_id: number | null;
  date: string;
  ticker: string;
  action: "buy" | "sell";
  kind: "entry" | "exit" | "protective";
  trigger_json: string;
  amount_usd: number | null;
  valid_until: string;
  stop_loss_json: string | null;
  take_profit_json: string | null;
  reason: string;
  status: "active" | "triggered" | "expired" | "cancelled" | "missed";
  triggered_at: string | null;
  created_at: string;
}

export interface PositionRow {
  ticker: string;
  shares: number;
  avg_cost: number;
  cost_basis: number;
  stop_loss_json: string | null;
  take_profit_json: string | null;
  source_rule_id: string | null;
  opened_at: string;
  updated_at: string;
}

export interface OrderRow {
  id: number;
  rule_id: string | null;
  ticker: string;
  side: "buy" | "sell";
  req_amount_usd: number | null;
  req_shares: number | null;
  mode: "live" | "dry" | "notify";
  status: "submitted" | "filled" | "failed" | "unverified" | "awaiting_manual" | "missed";
  wallbit_json: string | null;
  error: string | null;
  fill_price: number | null;
  fill_shares: number | null;
  fill_usd: number | null;
  requested_at: string;
  verified_at: string | null;
}

export interface DailyStateRow {
  date: string;
  day_start_equity: number | null;
  orders_count: number;
  buys_frozen: number;
  planner_ran: number;
  midday_ran: number;
  review_ran: number;
  closed: number;
}

export interface SnapshotRow {
  id: number;
  ts: string;
  date: string;
  equity_usd: number;
  cash_usd: number;
  invested_usd: number;
  positions_json: string;
  benchmark_price: number | null;
  benchmark_equity_usd: number | null;
  day_pnl_pct: number | null;
}

// Rebuilds a table in place when its stored DDL is missing newly added enum
// values (SQLite bakes CHECK constraints into the table definition).
function migrateTable(sqlite: Database, table: string, ddl: string, requiredToken: string, indexes: string[]) {
  const row = sqlite
    .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
  if (!row || row.sql.includes(requiredToken)) return;
  const tmp = `${table}_migrated`;
  sqlite.exec("BEGIN");
  try {
    sqlite.exec(`CREATE TABLE ${tmp} ${ddl}`);
    sqlite.exec(`INSERT INTO ${tmp} SELECT * FROM ${table}`);
    sqlite.exec(`DROP TABLE ${table}`);
    sqlite.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
    for (const idx of indexes) sqlite.exec(idx);
    sqlite.exec("COMMIT");
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  }
}

export function createDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  migrateTable(sqlite, "rules", RULES_DDL, "'missed'", [
    "CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status)",
    "CREATE INDEX IF NOT EXISTS idx_rules_date ON rules(date)",
  ]);
  migrateTable(sqlite, "orders", ORDERS_DDL, "'awaiting_manual'", [
    "CREATE INDEX IF NOT EXISTS idx_orders_requested ON orders(requested_at)",
    "CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)",
  ]);
  sqlite.exec(SCHEMA);

  const api = {
    sqlite,

    // ---- meta ----
    getMeta(key: string): string | null {
      const row = sqlite.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
      return row?.value ?? null;
    },
    setMeta(key: string, value: string) {
      sqlite.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },
    getMetaNum(key: string): number | null {
      const v = api.getMeta(key);
      return v === null ? null : Number(v);
    },

    // ---- plans ----
    insertPlan(date: string, kind: "premarket" | "midday" | "fallback", thesis: string, json: string, status = "active"): number {
      const res = sqlite
        .query("INSERT INTO plans (date, kind, thesis, json, status) VALUES (?, ?, ?, ?, ?)")
        .run(date, kind, thesis, json, status);
      return Number(res.lastInsertRowid);
    },
    hasAnyPlan(): boolean {
      return sqlite.query("SELECT 1 FROM plans LIMIT 1").get() !== null;
    },
    latestPlan(date: string): { id: number; thesis: string; json: string; kind: string; created_at: string } | null {
      return sqlite
        .query<{ id: number; thesis: string; json: string; kind: string; created_at: string }, [string]>(
          "SELECT id, thesis, json, kind, created_at FROM plans WHERE date = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
        )
        .get(date);
    },
    planForDate(date: string): { id: number; thesis: string; json: string; kind: string } | null {
      return sqlite
        .query<{ id: number; thesis: string; json: string; kind: string }, [string]>(
          "SELECT id, thesis, json, kind FROM plans WHERE date = ? ORDER BY id DESC LIMIT 1",
        )
        .get(date);
    },

    // ---- rules ----
    insertRule(r: {
      id: string;
      planId: number | null;
      date: string;
      ticker: string;
      action: "buy" | "sell";
      kind: "entry" | "exit" | "protective";
      triggerJson: string;
      amountUsd: number | null;
      validUntil: string;
      stopLossJson: string | null;
      takeProfitJson: string | null;
      reason: string;
    }) {
      sqlite
        .query(
          `INSERT INTO rules (id, plan_id, date, ticker, action, kind, trigger_json, amount_usd, valid_until, stop_loss_json, take_profit_json, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.planId,
          r.date,
          r.ticker,
          r.action,
          r.kind,
          r.triggerJson,
          r.amountUsd,
          r.validUntil,
          r.stopLossJson,
          r.takeProfitJson,
          r.reason,
        );
    },
    activeRules(): RuleRow[] {
      return sqlite.query<RuleRow, []>("SELECT * FROM rules WHERE status = 'active'").all();
    },
    ruleById(id: string): RuleRow | null {
      return sqlite.query<RuleRow, [string]>("SELECT * FROM rules WHERE id = ?").get(id);
    },
    // Atomic claim: returns true only for the first caller. This is the
    // idempotency guarantee that a rule never executes twice.
    claimRule(id: string): boolean {
      const res = sqlite
        .query("UPDATE rules SET status = 'triggered', triggered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'active'")
        .run(id);
      return res.changes === 1;
    },
    reactivateRule(id: string) {
      sqlite.query("UPDATE rules SET status = 'active', triggered_at = NULL WHERE id = ?").run(id);
    },
    setRuleStatus(id: string, status: RuleRow["status"]) {
      sqlite.query("UPDATE rules SET status = ? WHERE id = ?").run(status, id);
    },
    expireRule(id: string) {
      sqlite.query("UPDATE rules SET status = 'expired' WHERE id = ? AND status = 'active'").run(id);
    },
    cancelRule(id: string) {
      sqlite.query("UPDATE rules SET status = 'cancelled' WHERE id = ? AND status = 'active'").run(id);
    },
    cancelActiveEntryRulesForDate(date: string) {
      sqlite.query("UPDATE rules SET status = 'cancelled' WHERE date = ? AND kind = 'entry' AND status = 'active'").run(date);
    },
    ruleStats(sinceDate: string): { status: string; n: number }[] {
      return sqlite
        .query<{ status: string; n: number }, [string]>(
          "SELECT status, COUNT(*) as n FROM rules WHERE date >= ? GROUP BY status",
        )
        .all(sinceDate);
    },

    // ---- orders ----
    insertOrder(o: {
      ruleId: string | null;
      ticker: string;
      side: "buy" | "sell";
      reqAmountUsd: number | null;
      reqShares: number | null;
      mode: "live" | "dry" | "notify";
      status: OrderRow["status"];
      wallbitJson?: string | null;
      error?: string | null;
      fillPrice?: number | null;
      fillShares?: number | null;
      fillUsd?: number | null;
    }): number {
      const res = sqlite
        .query(
          `INSERT INTO orders (rule_id, ticker, side, req_amount_usd, req_shares, mode, status, wallbit_json, error, fill_price, fill_shares, fill_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          o.ruleId,
          o.ticker,
          o.side,
          o.reqAmountUsd,
          o.reqShares,
          o.mode,
          o.status,
          o.wallbitJson ?? null,
          o.error ?? null,
          o.fillPrice ?? null,
          o.fillShares ?? null,
          o.fillUsd ?? null,
        );
      return Number(res.lastInsertRowid);
    },
    updateOrder(id: number, fields: Partial<Pick<OrderRow, "status" | "wallbit_json" | "error" | "fill_price" | "fill_shares" | "fill_usd" | "verified_at">>) {
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = ?`);
        vals.push(v as string | number | null);
      }
      if (sets.length === 0) return;
      vals.push(id);
      sqlite.query(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    },
    ordersForDate(date: string): OrderRow[] {
      return sqlite
        .query<OrderRow, [string]>("SELECT * FROM orders WHERE substr(requested_at, 1, 10) = ? ORDER BY id")
        .all(date);
    },
    recentOrders(limit: number): OrderRow[] {
      return sqlite.query<OrderRow, [number]>("SELECT * FROM orders ORDER BY id DESC LIMIT ?").all(limit);
    },
    // Orders still waiting for confirmation against the real portfolio:
    // live submissions and manual signals awaiting the human.
    pendingVerificationOrders(): OrderRow[] {
      return sqlite
        .query<OrderRow, []>(
          "SELECT * FROM orders WHERE (mode = 'live' AND status = 'submitted') OR (mode = 'notify' AND status = 'awaiting_manual')",
        )
        .all();
    },

    // ---- positions ----
    getPosition(ticker: string): PositionRow | null {
      return sqlite.query<PositionRow, [string]>("SELECT * FROM positions WHERE ticker = ?").get(ticker);
    },
    allPositions(): PositionRow[] {
      return sqlite.query<PositionRow, []>("SELECT * FROM positions ORDER BY ticker").all();
    },
    applyBuyFill(p: {
      ticker: string;
      shares: number;
      fillUsd: number;
      stopLossJson: string | null;
      takeProfitJson: string | null;
      sourceRuleId: string | null;
    }) {
      const now = new Date().toISOString();
      const existing = api.getPosition(p.ticker);
      if (existing) {
        const shares = existing.shares + p.shares;
        const costBasis = existing.cost_basis + p.fillUsd;
        sqlite
          .query(
            `UPDATE positions SET shares = ?, cost_basis = ?, avg_cost = ?, stop_loss_json = COALESCE(?, stop_loss_json),
             take_profit_json = COALESCE(?, take_profit_json), source_rule_id = COALESCE(?, source_rule_id), updated_at = ? WHERE ticker = ?`,
          )
          .run(shares, costBasis, costBasis / shares, p.stopLossJson, p.takeProfitJson, p.sourceRuleId, now, p.ticker);
      } else {
        sqlite
          .query(
            `INSERT INTO positions (ticker, shares, avg_cost, cost_basis, stop_loss_json, take_profit_json, source_rule_id, opened_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(p.ticker, p.shares, p.fillUsd / p.shares, p.fillUsd, p.stopLossJson, p.takeProfitJson, p.sourceRuleId, now, now);
      }
    },
    // Returns realized P&L for the sold shares.
    applySellFill(p: { ticker: string; shares: number; proceedsUsd: number; ruleId: string | null; reason: string }): number {
      const pos = api.getPosition(p.ticker);
      if (!pos) return 0;
      const soldShares = Math.min(p.shares, pos.shares);
      const costOfSold = pos.avg_cost * soldShares;
      const pnl = p.proceedsUsd - costOfSold;
      const remaining = pos.shares - soldShares;
      const now = new Date().toISOString();
      if (remaining <= 1e-9) {
        sqlite.query("DELETE FROM positions WHERE ticker = ?").run(p.ticker);
      } else {
        sqlite
          .query("UPDATE positions SET shares = ?, cost_basis = ?, updated_at = ? WHERE ticker = ?")
          .run(remaining, pos.avg_cost * remaining, now, p.ticker);
      }
      sqlite
        .query(
          `INSERT INTO realized_trades (ticker, shares, proceeds_usd, cost_usd, pnl_usd, rule_id, reason, opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(p.ticker, soldShares, p.proceedsUsd, costOfSold, pnl, p.ruleId, p.reason, pos.opened_at);
      return pnl;
    },
    setPositionProtection(ticker: string, stopLossJson: string | null, takeProfitJson: string | null) {
      sqlite
        .query("UPDATE positions SET stop_loss_json = COALESCE(?, stop_loss_json), take_profit_json = COALESCE(?, take_profit_json), updated_at = ? WHERE ticker = ?")
        .run(stopLossJson, takeProfitJson, new Date().toISOString(), ticker);
    },
    replacePositions(rows: { ticker: string; shares: number; avgCost: number }[]) {
      const tx = sqlite.transaction(() => {
        sqlite.query("DELETE FROM positions").run();
        const now = new Date().toISOString();
        for (const r of rows) {
          sqlite
            .query(
              `INSERT INTO positions (ticker, shares, avg_cost, cost_basis, opened_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(r.ticker, r.shares, r.avgCost, r.avgCost * r.shares, now, now);
        }
      });
      tx();
    },

    // ---- realized ----
    realizedTrades(limit: number) {
      return sqlite
        .query<{ ticker: string; shares: number; proceeds_usd: number; cost_usd: number; pnl_usd: number; reason: string; closed_at: string }, [number]>(
          "SELECT ticker, shares, proceeds_usd, cost_usd, pnl_usd, reason, closed_at FROM realized_trades ORDER BY id DESC LIMIT ?",
        )
        .all(limit);
    },
    realizedPnlSince(date: string): number {
      const row = sqlite
        .query<{ s: number | null }, [string]>("SELECT SUM(pnl_usd) as s FROM realized_trades WHERE closed_at >= ?")
        .get(date);
      return row?.s ?? 0;
    },

    // ---- journal ----
    addJournal(date: string, type: "plan" | "midday" | "review" | "event" | "day_close", content: string) {
      sqlite.query("INSERT INTO journal (date, type, content) VALUES (?, ?, ?)").run(date, type, content);
    },
    recentJournal(limit: number): { date: string; type: string; content: string; created_at: string }[] {
      return sqlite
        .query<{ date: string; type: string; content: string; created_at: string }, [number]>(
          "SELECT date, type, content, created_at FROM journal ORDER BY id DESC LIMIT ?",
        )
        .all(limit);
    },
    journalBetween(from: string, to: string) {
      return sqlite
        .query<{ date: string; type: string; content: string }, [string, string]>(
          "SELECT date, type, content FROM journal WHERE date >= ? AND date <= ? ORDER BY id",
        )
        .all(from, to);
    },

    // ---- api costs ----
    addApiCost(c: {
      date: string;
      purpose: string;
      model: string;
      inputTokens: number;
      cacheWriteTokens: number;
      cacheReadTokens: number;
      outputTokens: number;
      webSearches: number;
      costUsd: number;
    }) {
      sqlite
        .query(
          `INSERT INTO api_costs (date, purpose, model, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, web_searches, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(c.date, c.purpose, c.model, c.inputTokens, c.cacheWriteTokens, c.cacheReadTokens, c.outputTokens, c.webSearches, c.costUsd);
    },
    totalApiCost(): number {
      const row = sqlite.query<{ s: number | null }, []>("SELECT SUM(cost_usd) as s FROM api_costs").get();
      return row?.s ?? 0;
    },
    apiCostForDate(date: string): number {
      const row = sqlite
        .query<{ s: number | null }, [string]>("SELECT SUM(cost_usd) as s FROM api_costs WHERE date = ?")
        .get(date);
      return row?.s ?? 0;
    },

    // ---- equity snapshots ----
    addSnapshot(s: {
      date: string;
      equityUsd: number;
      cashUsd: number;
      investedUsd: number;
      positionsJson: string;
      benchmarkPrice: number | null;
      benchmarkEquityUsd: number | null;
      dayPnlPct: number | null;
    }) {
      sqlite
        .query(
          `INSERT INTO equity_snapshots (date, equity_usd, cash_usd, invested_usd, positions_json, benchmark_price, benchmark_equity_usd, day_pnl_pct)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(s.date, s.equityUsd, s.cashUsd, s.investedUsd, s.positionsJson, s.benchmarkPrice, s.benchmarkEquityUsd, s.dayPnlPct);
    },
    latestSnapshot(): SnapshotRow | null {
      return sqlite.query<SnapshotRow, []>("SELECT * FROM equity_snapshots ORDER BY id DESC LIMIT 1").get();
    },
    dailyCloseSnapshots(limit: number): SnapshotRow[] {
      return sqlite
        .query<SnapshotRow, [number]>(
          `SELECT * FROM equity_snapshots WHERE id IN (SELECT MAX(id) FROM equity_snapshots GROUP BY date) ORDER BY date DESC LIMIT ?`,
        )
        .all(limit);
    },
    snapshotsSince(ts: string): SnapshotRow[] {
      return sqlite.query<SnapshotRow, [string]>("SELECT * FROM equity_snapshots WHERE ts >= ? ORDER BY id").all(ts);
    },

    // ---- daily state ----
    getDailyState(date: string): DailyStateRow {
      sqlite.query("INSERT OR IGNORE INTO daily_state (date) VALUES (?)").run(date);
      return sqlite.query<DailyStateRow, [string]>("SELECT * FROM daily_state WHERE date = ?").get(date)!;
    },
    setDailyState(date: string, fields: Partial<Omit<DailyStateRow, "date">>) {
      api.getDailyState(date);
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = ?`);
        vals.push(v as number | null);
      }
      if (sets.length === 0) return;
      vals.push(date);
      sqlite.query(`UPDATE daily_state SET ${sets.join(", ")} WHERE date = ?`).run(...vals);
    },
    incrementOrdersCount(date: string): number {
      api.getDailyState(date);
      sqlite.query("UPDATE daily_state SET orders_count = orders_count + 1 WHERE date = ?").run(date);
      return api.getDailyState(date).orders_count;
    },

    // ---- heartbeat ----
    setHeartbeat() {
      api.setMeta("last_heartbeat", new Date().toISOString());
    },
    getHeartbeat(): string | null {
      return api.getMeta("last_heartbeat");
    },

    // ---- events ----
    addEvent(type: string, payload: unknown) {
      sqlite.query("INSERT INTO events (type, payload_json) VALUES (?, ?)").run(type, JSON.stringify(payload ?? {}));
    },
    recentEvents(limit: number) {
      return sqlite
        .query<{ ts: string; type: string; payload_json: string }, [number]>(
          "SELECT ts, type, payload_json FROM events ORDER BY id DESC LIMIT ?",
        )
        .all(limit);
    },

    close() {
      sqlite.close();
    },
  };

  return api;
}

export type Db = ReturnType<typeof createDb>;

let singleton: Db | null = null;
export function getDb(): Db {
  if (!singleton) singleton = createDb(config.dbPath);
  return singleton;
}
