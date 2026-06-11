import { describe, expect, test } from "bun:test";
import { LiveBroker, PaperBroker } from "../src/broker.ts";
import { createDb, type Db } from "../src/db.ts";
import { DEFAULT_GUARDRAILS } from "../src/guardrails.ts";
import { createExecutor, type ExecutorDeps } from "../src/executor.ts";
import type { Quote } from "../src/rules.ts";
import type { WallbitClient } from "../src/wallbit.ts";

const NOW = new Date("2026-06-10T15:00:00Z"); // 11:00 ET, Wednesday
const TODAY = "2026-06-10";

function quote(ticker: string, price: number, prevClose: number | null = null): Quote {
  return { ticker, price, prevClose, dayOpen: null, ts: NOW.getTime(), source: "test" };
}

interface Harness {
  db: Db;
  deps: ExecutorDeps;
  notifications: { event: string; title: string }[];
  setQuotes: (qs: Quote[]) => void;
  tick: () => ReturnType<ReturnType<typeof createExecutor>["tick"]>;
}

function harness(): Harness {
  const db = createDb(":memory:");
  const broker = new PaperBroker(db);
  const quotes = new Map<string, Quote>();
  const notifications: { event: string; title: string }[] = [];
  const deps: ExecutorDeps = {
    db,
    broker,
    fetchQuotes: async (tickers) => {
      const out = new Map<string, Quote>();
      for (const t of tickers) {
        const q = quotes.get(t);
        if (q) out.set(t, q);
      }
      return out;
    },
    notify: async (event, title) => {
      notifications.push({ event, title });
    },
    now: () => NOW,
    marketOpen: () => true,
    assetCheck: async (_t, q) => ({ inCatalog: q !== null, price: q?.price ?? null, assetType: "Stock" }),
    guardrails: DEFAULT_GUARDRAILS,
    benchmarkTicker: "SPY",
    snapshotIntervalMin: 5,
  };
  const executor = createExecutor(deps);
  return {
    db,
    deps,
    notifications,
    setQuotes: (qs) => {
      quotes.clear();
      for (const q of qs) quotes.set(q.ticker, q);
    },
    tick: () => executor.tick(),
  };
}

function insertBuyRule(db: Db, opts: { id?: string; ticker?: string; triggerValue?: number; amount?: number } = {}) {
  db.insertRule({
    id: opts.id ?? `${TODAY}:buy-1`,
    planId: null,
    date: TODAY,
    ticker: opts.ticker ?? "NVDA",
    action: "buy",
    kind: "entry",
    triggerJson: JSON.stringify({ type: "price_below", value: opts.triggerValue ?? 105 }),
    amountUsd: opts.amount ?? 40,
    validUntil: "2026-06-10T16:00:00-04:00",
    stopLossJson: JSON.stringify({ type: "price_below", value: 90 }),
    takeProfitJson: JSON.stringify({ type: "price_above", value: 120 }),
    reason: "test buy",
  });
}

describe("executor dry-run", () => {
  test("buy rule fires once, creates position with protection, never re-fires", async () => {
    const h = harness();
    insertBuyRule(h.db);
    h.setQuotes([quote("NVDA", 100, 102), quote("SPY", 500, 500)]);

    const s1 = await h.tick();
    expect(s1.fired).toEqual([`${TODAY}:buy-1`]);
    const pos = h.db.getPosition("NVDA")!;
    expect(pos.shares).toBeCloseTo(0.4);
    expect(pos.cost_basis).toBeCloseTo(40);
    expect(pos.stop_loss_json).toContain("price_below");
    expect(h.db.getDailyState(TODAY).orders_count).toBe(1);
    const orders = h.db.recentOrders(10);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.mode).toBe("dry");
    expect(orders[0]!.status).toBe("filled");

    const s2 = await h.tick();
    expect(s2.fired).toEqual([]);
    expect(h.db.recentOrders(10)).toHaveLength(1);
    expect(h.notifications.filter((n) => n.event === "order_executed")).toHaveLength(1);
  });

  test("rule does not fire when trigger not met, expires after validUntil", async () => {
    const h = harness();
    insertBuyRule(h.db, { triggerValue: 95 });
    h.setQuotes([quote("NVDA", 100), quote("SPY", 500)]);
    const s1 = await h.tick();
    expect(s1.fired).toEqual([]);
    expect(h.db.ruleById(`${TODAY}:buy-1`)!.status).toBe("active");

    h.db.sqlite.query("UPDATE rules SET valid_until = '2026-06-10T10:00:00-04:00'").run();
    const s2 = await h.tick();
    expect(s2.expired).toEqual([`${TODAY}:buy-1`]);
    expect(h.db.ruleById(`${TODAY}:buy-1`)!.status).toBe("expired");
  });

  test("stop loss on a position sells it even with no plan for the day", async () => {
    const h = harness();
    h.db.applyBuyFill({
      ticker: "TSLA",
      shares: 0.5,
      fillUsd: 60,
      stopLossJson: JSON.stringify({ type: "price_below", value: 110 }),
      takeProfitJson: null,
      sourceRuleId: null,
    });
    h.setQuotes([quote("TSLA", 105), quote("SPY", 500)]);
    const s = await h.tick();
    expect(s.protectiveSells).toEqual(["TSLA"]);
    expect(h.db.getPosition("TSLA")).toBeNull();
    const realized = h.db.realizedTrades(5);
    expect(realized).toHaveLength(1);
    expect(realized[0]!.pnl_usd).toBeCloseTo(0.5 * 105 - 60);
  });

  test("take profit fires when stop does not", async () => {
    const h = harness();
    h.db.applyBuyFill({
      ticker: "TSLA",
      shares: 0.5,
      fillUsd: 60,
      stopLossJson: JSON.stringify({ type: "price_below", value: 100 }),
      takeProfitJson: JSON.stringify({ type: "price_above", value: 140 }),
      sourceRuleId: null,
    });
    h.setQuotes([quote("TSLA", 141), quote("SPY", 500)]);
    const s = await h.tick();
    expect(s.protectiveSells).toEqual(["TSLA"]);
    expect(h.db.realizedTrades(5)[0]!.pnl_usd).toBeCloseTo(0.5 * 141 - 60);
  });

  test("daily stop freezes buys but exits keep working", async () => {
    const h = harness();
    h.db.setDailyState(TODAY, { day_start_equity: 250 }); // equity will be 200 (150 cash + 50 pos) -> -20%
    insertBuyRule(h.db);
    h.db.applyBuyFill({
      ticker: "TSLA",
      shares: 0.5,
      fillUsd: 60,
      stopLossJson: JSON.stringify({ type: "price_below", value: 110 }),
      takeProfitJson: null,
      sourceRuleId: null,
    });
    h.setQuotes([quote("NVDA", 100), quote("TSLA", 100), quote("SPY", 500)]);

    const s = await h.tick();
    expect(h.db.getDailyState(TODAY).buys_frozen).toBe(1);
    expect(h.notifications.some((n) => n.event === "daily_stop")).toBe(true);
    expect(s.fired).toEqual([]); // buy skipped
    expect(h.db.ruleById(`${TODAY}:buy-1`)!.status).toBe("active");
    expect(s.protectiveSells).toEqual(["TSLA"]); // exit still ran
  });

  test("kill switch freezes everything and persists", async () => {
    const h = harness();
    h.db.setMeta("initial_capital", "1000"); // equity 150 < 65% of 1000
    insertBuyRule(h.db);
    h.setQuotes([quote("NVDA", 100), quote("SPY", 500)]);

    const s1 = await h.tick();
    expect(s1.skipped).toBe("kill_switch");
    expect(h.db.getMeta("kill_switch")).toBe("1");
    expect(h.notifications.some((n) => n.event === "kill_switch")).toBe(true);
    expect(h.db.ordersForDate(TODAY)).toHaveLength(0);

    const s2 = await h.tick();
    expect(s2.skipped).toBe("kill_switch");
    expect(h.db.ordersForDate(TODAY)).toHaveLength(0);
  });

  test("market closed skips everything", async () => {
    const h = harness();
    h.deps.marketOpen = () => false;
    const executor = createExecutor(h.deps);
    insertBuyRule(h.db);
    const s = await executor.tick();
    expect(s.skipped).toBe("market_closed");
    expect(h.db.ruleById(`${TODAY}:buy-1`)!.status).toBe("active");
  });

  test("guardrail rejection cancels the rule and journals it", async () => {
    const h = harness();
    insertBuyRule(h.db, { amount: 100 }); // 100 > 40% of 150 -> position_cap
    h.setQuotes([quote("NVDA", 100), quote("SPY", 500)]);
    const s = await h.tick();
    expect(s.fired).toEqual([]);
    expect(h.db.ruleById(`${TODAY}:buy-1`)!.status).toBe("cancelled");
    expect(h.db.recentJournal(5).some((j) => j.content.includes("position_cap"))).toBe(true);
    expect(h.db.ordersForDate(TODAY)).toHaveLength(0);
  });

  test("plan exit rule sells existing position", async () => {
    const h = harness();
    h.db.applyBuyFill({ ticker: "AAPL", shares: 0.3, fillUsd: 45, stopLossJson: null, takeProfitJson: null, sourceRuleId: null });
    h.db.insertRule({
      id: `${TODAY}:exit-aapl`,
      planId: null,
      date: TODAY,
      ticker: "AAPL",
      action: "sell",
      kind: "exit",
      triggerJson: JSON.stringify({ type: "pct_change_intraday_above", value: 3 }),
      amountUsd: null,
      validUntil: "2026-06-10T16:00:00-04:00",
      stopLossJson: null,
      takeProfitJson: null,
      reason: "sell the pop",
    });
    h.setQuotes([quote("AAPL", 160, 150), quote("SPY", 500)]); // +6.7%
    const s = await h.tick();
    expect(s.fired).toEqual([`${TODAY}:exit-aapl`]);
    expect(h.db.getPosition("AAPL")).toBeNull();
    expect(h.db.realizedTrades(5)[0]!.pnl_usd).toBeCloseTo(0.3 * 160 - 45);
  });

  test("missing quote leaves rule active for next tick", async () => {
    const h = harness();
    insertBuyRule(h.db);
    h.setQuotes([quote("SPY", 500)]); // no NVDA quote
    const s = await h.tick();
    expect(s.fired).toEqual([]);
    expect(h.db.ruleById(`${TODAY}:buy-1`)!.status).toBe("active");
  });

  test("equity snapshot records benchmark baseline", async () => {
    const h = harness();
    h.setQuotes([quote("SPY", 500, 498)]);
    await h.tick();
    const snap = h.db.latestSnapshot()!;
    expect(snap.equity_usd).toBeCloseTo(100);
    expect(snap.benchmark_price).toBe(500);
    expect(snap.benchmark_equity_usd).toBeCloseTo(100); // baseline day
    expect(h.db.getMetaNum("benchmark_initial_price")).toBe(500);
  });
});

describe("LiveBroker fill verification", () => {
  function fakeClient() {
    const state = { shares: new Map<string, number>([["USD", 150]]), trades: [] as unknown[] };
    const client = {
      hasKey: true,
      async getStocksBalance() {
        return [...state.shares.entries()].map(([symbol, shares]) => ({ symbol, shares }));
      },
      async createTrade(req: { symbol: string; direction: string; amount?: number; shares?: number }) {
        state.trades.push(req);
        return { symbol: req.symbol, direction: req.direction, status: "REQUESTED", order_type: "MARKET", created_at: "", updated_at: "" };
      },
    };
    return { state, client: client as unknown as WallbitClient };
  }

  test("buy fill detected from share delta", async () => {
    const db = createDb(":memory:");
    const { state, client } = fakeClient();
    const broker = new LiveBroker(db, client);

    const res = await broker.submitBuy("NVDA", 40, { ticker: "NVDA", price: 100, prevClose: null, dayOpen: null, ts: Date.now(), source: "t" }, "rule-1");
    expect(res.ok).toBe(true);
    expect(db.recentOrders(1)[0]!.status).toBe("submitted");

    // nothing filled yet
    expect(await broker.verifyPending()).toHaveLength(0);

    state.shares.set("NVDA", 0.4);
    const fills = await broker.verifyPending();
    expect(fills).toHaveLength(1);
    expect(fills[0]!.fillShares).toBeCloseTo(0.4);
    expect(fills[0]!.fillUsd).toBeCloseTo(40);
    expect(db.recentOrders(1)[0]!.status).toBe("filled");

    // verification is idempotent
    expect(await broker.verifyPending()).toHaveLength(0);
  });

  test("sell fill detected and unfilled order flagged after 15min", async () => {
    const db = createDb(":memory:");
    const { state, client } = fakeClient();
    state.shares.set("TSLA", 0.5);
    const broker = new LiveBroker(db, client);

    const res = await broker.submitSell("TSLA", 0.5, { ticker: "TSLA", price: 200, prevClose: null, dayOpen: null, ts: Date.now(), source: "t" }, null, "stop");
    expect(res.ok).toBe(true);

    state.shares.set("TSLA", 0);
    const fills = await broker.verifyPending();
    expect(fills).toHaveLength(1);
    expect(fills[0]!.side).toBe("sell");
    expect(fills[0]!.fillUsd).toBeCloseTo(100);

    // stale unfilled order
    const res2 = await broker.submitBuy("AAPL", 20, { ticker: "AAPL", price: 150, prevClose: null, dayOpen: null, ts: Date.now(), source: "t" }, null);
    db.sqlite
      .query("UPDATE orders SET requested_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 20 * 60000).toISOString(), res2.orderId);
    await broker.verifyPending();
    expect(db.recentOrders(1)[0]!.status).toBe("unverified");
  });

  test("sell with no shares at broker fails fast", async () => {
    const db = createDb(":memory:");
    const { client } = fakeClient();
    const broker = new LiveBroker(db, client);
    const res = await broker.submitSell("XYZ", 1, { ticker: "XYZ", price: 10, prevClose: null, dayOpen: null, ts: Date.now(), source: "t" }, null, "x");
    expect(res.ok).toBe(false);
    expect(db.recentOrders(1)[0]!.status).toBe("failed");
  });
});
