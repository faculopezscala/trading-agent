import { describe, expect, test } from "bun:test";
import { NotifyBroker } from "../src/broker.ts";
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

function fakeClient(initial: [string, number][] = [["USD", 150]]) {
  const state = { shares: new Map<string, number>(initial) };
  const client = {
    hasKey: true,
    async getStocksBalance() {
      return [...state.shares.entries()].map(([symbol, shares]) => ({ symbol, shares }));
    },
    async createTrade() {
      throw new Error("notify mode must never call createTrade");
    },
  };
  return { state, client: client as unknown as WallbitClient };
}

function notifyHarness() {
  const db = createDb(":memory:");
  const { state, client } = fakeClient();
  const notifications: { event: string; title: string; message: string }[] = [];
  const send = async (event: string, title: string, message: string) => {
    notifications.push({ event, title, message });
  };
  const quoteFn = async (t: string) => quotesMap.get(t) ?? null;
  const quotesMap = new Map<string, Quote>();
  const broker = new NotifyBroker(db, client, send as never, quoteFn);
  return { db, state, broker, notifications, quotesMap };
}

function insertBuyRule(db: Db, id = `${TODAY}:buy-1`) {
  db.insertRule({
    id,
    planId: null,
    date: TODAY,
    ticker: "NVDA",
    action: "buy",
    kind: "entry",
    triggerJson: JSON.stringify({ type: "price_below", value: 105 }),
    amountUsd: 40,
    validUntil: "2026-06-10T16:00:00-04:00",
    stopLossJson: JSON.stringify({ type: "price_below", value: 90 }),
    takeProfitJson: JSON.stringify({ type: "price_above", value: 120 }),
    reason: "test buy",
  });
}

function backdateOrder(db: Db, orderId: number, minutes: number) {
  db.sqlite
    .query("UPDATE orders SET requested_at = ? WHERE id = ?")
    .run(new Date(Date.now() - minutes * 60000).toISOString(), orderId);
}

describe("NotifyBroker signals", () => {
  test("submitBuy emits exact manual signal with SL/TP and stores awaiting_manual", async () => {
    const h = notifyHarness();
    insertBuyRule(h.db);
    const res = await h.broker.submitBuy("NVDA", 40, quote("NVDA", 142.3), `${TODAY}:buy-1`);
    expect(res.ok).toBe(true);
    expect(res.immediateFill).toBeNull();
    const order = h.db.recentOrders(1)[0]!;
    expect(order.mode).toBe("notify");
    expect(order.status).toBe("awaiting_manual");
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]!.event).toBe("order_signal");
    expect(h.notifications[0]!.title).toContain("COMPRAR NVDA $40");
    expect(h.notifications[0]!.message).toContain("$142.30");
    expect(h.notifications[0]!.message).toContain("stop loss precio <= $90.00");
    expect(h.notifications[0]!.message).toContain("take profit precio >= $120.00");
  });

  test("submitSell emits sell signal with shares and reason", async () => {
    const h = notifyHarness();
    h.state.shares.set("TSLA", 0.5);
    const res = await h.broker.submitSell("TSLA", 0.5, quote("TSLA", 200), null, "stop_loss");
    expect(res.ok).toBe(true);
    expect(h.notifications[0]!.title).toContain("VENDER TSLA");
    expect(h.notifications[0]!.message).toContain("0.500000 shares");
    expect(h.notifications[0]!.message).toContain("stop_loss");
  });

  test("manual buy fill detected by share delta", async () => {
    const h = notifyHarness();
    await h.broker.submitBuy("NVDA", 40, quote("NVDA", 100), null);
    expect(await h.broker.reconcile()).toHaveLength(0); // not executed yet

    h.state.shares.set("NVDA", 0.4); // human executed in the app
    const fills = await h.broker.reconcile();
    expect(fills).toHaveLength(1);
    expect(fills[0]!.fillShares).toBeCloseTo(0.4);
    expect(fills[0]!.fillUsd).toBeCloseTo(40);
    expect(fills[0]!.external).toBe(false);
    expect(h.db.recentOrders(1)[0]!.status).toBe("filled");
    // The executor applies the fill to the book; mirror that here.
    h.db.applyBuyFill({ ticker: "NVDA", shares: fills[0]!.fillShares, fillUsd: fills[0]!.fillUsd, stopLossJson: null, takeProfitJson: null, sourceRuleId: null });
    // idempotent: order is filled and the position now exists, nothing re-detected
    expect(await h.broker.reconcile()).toHaveLength(0);
  });

  test("re-notifies once at 15min, marks order+rule missed at 30min", async () => {
    const h = notifyHarness();
    insertBuyRule(h.db);
    h.db.claimRule(`${TODAY}:buy-1`);
    const res = await h.broker.submitBuy("NVDA", 40, quote("NVDA", 100), `${TODAY}:buy-1`);
    expect(h.notifications).toHaveLength(1);

    backdateOrder(h.db, res.orderId, 16);
    await h.broker.reconcile();
    expect(h.notifications).toHaveLength(2);
    expect(h.notifications[1]!.title).toContain("RECORDATORIO");
    await h.broker.reconcile(); // no third reminder
    expect(h.notifications).toHaveLength(2);
    expect(h.db.recentOrders(1)[0]!.status).toBe("awaiting_manual");

    backdateOrder(h.db, res.orderId, 31);
    await h.broker.reconcile();
    expect(h.db.recentOrders(1)[0]!.status).toBe("missed");
    expect(h.db.ruleById(`${TODAY}:buy-1`)!.status).toBe("missed");
    expect(h.notifications[2]!.event).toBe("order_missed");
  });

  test("missed protective sell does NOT mark the originating buy rule missed", async () => {
    const h = notifyHarness();
    insertBuyRule(h.db);
    h.db.claimRule(`${TODAY}:buy-1`); // buy already executed
    h.state.shares.set("NVDA", 0.4);
    const res = await h.broker.submitSell("NVDA", 0.4, quote("NVDA", 85), `${TODAY}:buy-1`, "stop_loss");
    backdateOrder(h.db, res.orderId, 31);
    await h.broker.reconcile();
    expect(h.db.recentOrders(1)[0]!.status).toBe("missed");
    expect(h.db.ruleById(`${TODAY}:buy-1`)!.status).toBe("triggered"); // untouched
  });

  test("external sell (native stop executed in app) is detected", async () => {
    const h = notifyHarness();
    h.db.applyBuyFill({ ticker: "TSLA", shares: 0.5, fillUsd: 60, stopLossJson: null, takeProfitJson: null, sourceRuleId: null });
    h.state.shares.set("TSLA", 0.2); // user sold 0.3 manually
    h.quotesMap.set("TSLA", quote("TSLA", 110));
    const fills = await h.broker.reconcile();
    expect(fills).toHaveLength(1);
    expect(fills[0]!.side).toBe("sell");
    expect(fills[0]!.external).toBe(true);
    expect(fills[0]!.fillShares).toBeCloseTo(0.3);
    expect(fills[0]!.fillUsd).toBeCloseTo(33);
  });

  test("external new holding is adopted as a buy", async () => {
    const h = notifyHarness();
    h.state.shares.set("AMD", 0.25);
    h.quotesMap.set("AMD", quote("AMD", 200));
    const fills = await h.broker.reconcile();
    expect(fills).toHaveLength(1);
    expect(fills[0]!.side).toBe("buy");
    expect(fills[0]!.external).toBe(true);
    expect(fills[0]!.fillUsd).toBeCloseTo(50);
  });

  test("never calls the trade endpoint", async () => {
    const h = notifyHarness();
    await h.broker.submitBuy("NVDA", 40, quote("NVDA", 100), null);
    h.state.shares.set("NVDA", 0.4);
    await h.broker.reconcile(); // would throw if createTrade were called
  });
});

describe("executor with NotifyBroker end to end", () => {
  function executorHarness() {
    const db = createDb(":memory:");
    const { state, client } = fakeClient();
    const notifications: { event: string; title: string }[] = [];
    const quotes = new Map<string, Quote>();
    const send = async (event: string, title: string) => {
      notifications.push({ event, title });
    };
    const broker = new NotifyBroker(db, client, send as never, async (t) => quotes.get(t) ?? null);
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
      notify: send as never,
      now: () => NOW,
      marketOpen: () => true,
      assetCheck: async (_t, q) => ({ inCatalog: q !== null, price: q?.price ?? null, assetType: "Stock" }),
      guardrails: DEFAULT_GUARDRAILS,
      benchmarkTicker: "SPY",
      snapshotIntervalMin: 5,
    };
    return { db, state, notifications, quotes, executor: createExecutor(deps) };
  }

  test("full cycle: signal -> manual fill -> protection -> sell signal -> manual sell", async () => {
    const h = executorHarness();
    insertBuyRule(h.db);
    h.quotes.set("NVDA", quote("NVDA", 100, 102));
    h.quotes.set("SPY", quote("SPY", 500, 500));

    // Tick 1: rule fires -> signal sent, no position yet
    const s1 = await h.executor.tick();
    expect(s1.fired).toEqual([`${TODAY}:buy-1`]);
    expect(h.notifications.filter((n) => n.event === "order_signal")).toHaveLength(1);
    expect(h.db.getPosition("NVDA")).toBeNull();
    expect(h.db.recentOrders(1)[0]!.status).toBe("awaiting_manual");

    // Tick 2: still nothing executed -> no duplicate signal (inflight + claimed)
    await h.executor.tick();
    expect(h.notifications.filter((n) => n.event === "order_signal")).toHaveLength(1);

    // Human executes the buy in the app
    h.state.shares.set("NVDA", 0.4);
    await h.executor.tick();
    const pos = h.db.getPosition("NVDA")!;
    expect(pos.shares).toBeCloseTo(0.4);
    expect(pos.stop_loss_json).toContain("price_below");
    expect(h.notifications.some((n) => n.event === "order_executed" && n.title.includes("confirmado"))).toBe(true);

    // Price breaks the stop -> sell signal, position stays until manual fill
    h.quotes.set("NVDA", quote("NVDA", 85, 102));
    const s4 = await h.executor.tick();
    expect(s4.protectiveSells).toEqual(["NVDA"]);
    expect(h.db.getPosition("NVDA")).not.toBeNull();
    const sellSignals = h.notifications.filter((n) => n.event === "order_signal" && n.title.includes("VENDER"));
    expect(sellSignals).toHaveLength(1);

    // No duplicate sell signal while awaiting manual execution
    await h.executor.tick();
    expect(h.notifications.filter((n) => n.event === "order_signal" && n.title.includes("VENDER"))).toHaveLength(1);

    // Human sells in the app -> position closes with realized pnl
    h.state.shares.set("NVDA", 0);
    await h.executor.tick();
    expect(h.db.getPosition("NVDA")).toBeNull();
    const realized = h.db.realizedTrades(5);
    expect(realized).toHaveLength(1);
    expect(realized[0]!.pnl_usd).toBeCloseTo(0.4 * 85 - 40);
  });

  test("missed sell signal re-fires protection on a later tick", async () => {
    const h = executorHarness();
    h.db.applyBuyFill({
      ticker: "TSLA",
      shares: 0.5,
      fillUsd: 60,
      stopLossJson: JSON.stringify({ type: "price_below", value: 110 }),
      takeProfitJson: null,
      sourceRuleId: null,
    });
    h.state.shares.set("TSLA", 0.5);
    h.quotes.set("TSLA", quote("TSLA", 100));
    h.quotes.set("SPY", quote("SPY", 500));

    await h.executor.tick(); // sell signal 1
    expect(h.notifications.filter((n) => n.event === "order_signal")).toHaveLength(1);

    backdateOrder(h.db, h.db.recentOrders(1)[0]!.id, 31);
    await h.executor.tick(); // marks missed, then protection re-fires -> signal 2
    const signals = h.notifications.filter((n) => n.event === "order_signal");
    expect(signals.length).toBe(2);
    expect(h.notifications.some((n) => n.event === "order_missed")).toBe(true);
    expect(h.db.getPosition("TSLA")).not.toBeNull(); // still protected, still owned
  });
});
