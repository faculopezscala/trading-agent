import { describe, expect, test } from "bun:test";
import { createDb } from "../src/db.ts";

function freshDb() {
  return createDb(":memory:");
}

function insertTestRule(db: ReturnType<typeof createDb>, id = "2026-06-10:r1") {
  db.insertRule({
    id,
    planId: null,
    date: "2026-06-10",
    ticker: "NVDA",
    action: "buy",
    kind: "entry",
    triggerJson: '{"type":"price_below","value":100}',
    amountUsd: 40,
    validUntil: "2026-06-10T16:00:00-04:00",
    stopLossJson: '{"type":"price_below","value":90}',
    takeProfitJson: null,
    reason: "test",
  });
}

describe("rule idempotency", () => {
  test("claimRule succeeds once, then never again", () => {
    const db = freshDb();
    insertTestRule(db);
    expect(db.claimRule("2026-06-10:r1")).toBe(true);
    expect(db.claimRule("2026-06-10:r1")).toBe(false);
    expect(db.claimRule("2026-06-10:r1")).toBe(false);
    expect(db.ruleById("2026-06-10:r1")!.status).toBe("triggered");
  });

  test("expireRule only touches active rules", () => {
    const db = freshDb();
    insertTestRule(db);
    db.claimRule("2026-06-10:r1");
    db.expireRule("2026-06-10:r1");
    expect(db.ruleById("2026-06-10:r1")!.status).toBe("triggered");
  });

  test("cancelActiveEntryRulesForDate spares triggered rules and exits", () => {
    const db = freshDb();
    insertTestRule(db, "2026-06-10:r1");
    insertTestRule(db, "2026-06-10:r2");
    db.insertRule({
      id: "2026-06-10:exit1",
      planId: null,
      date: "2026-06-10",
      ticker: "AAPL",
      action: "sell",
      kind: "exit",
      triggerJson: '{"type":"price_above","value":200}',
      amountUsd: null,
      validUntil: "2026-06-10T16:00:00-04:00",
      stopLossJson: null,
      takeProfitJson: null,
      reason: "",
    });
    db.claimRule("2026-06-10:r1");
    db.cancelActiveEntryRulesForDate("2026-06-10");
    expect(db.ruleById("2026-06-10:r1")!.status).toBe("triggered");
    expect(db.ruleById("2026-06-10:r2")!.status).toBe("cancelled");
    expect(db.ruleById("2026-06-10:exit1")!.status).toBe("active");
  });
});

describe("position accounting", () => {
  test("avg cost across two buys", () => {
    const db = freshDb();
    db.applyBuyFill({ ticker: "NVDA", shares: 1, fillUsd: 100, stopLossJson: null, takeProfitJson: null, sourceRuleId: null });
    db.applyBuyFill({ ticker: "NVDA", shares: 1, fillUsd: 120, stopLossJson: '{"type":"price_below","value":90}', takeProfitJson: null, sourceRuleId: "r2" });
    const pos = db.getPosition("NVDA")!;
    expect(pos.shares).toBe(2);
    expect(pos.cost_basis).toBe(220);
    expect(pos.avg_cost).toBeCloseTo(110);
    expect(pos.stop_loss_json).toBe('{"type":"price_below","value":90}');
  });

  test("partial sell keeps avg cost, books pnl", () => {
    const db = freshDb();
    db.applyBuyFill({ ticker: "NVDA", shares: 2, fillUsd: 200, stopLossJson: null, takeProfitJson: null, sourceRuleId: null });
    const pnl = db.applySellFill({ ticker: "NVDA", shares: 1, proceedsUsd: 130, ruleId: null, reason: "tp" });
    expect(pnl).toBeCloseTo(30);
    const pos = db.getPosition("NVDA")!;
    expect(pos.shares).toBe(1);
    expect(pos.cost_basis).toBeCloseTo(100);
    expect(db.realizedPnlSince("1970-01-01")).toBeCloseTo(30);
  });

  test("full sell removes position", () => {
    const db = freshDb();
    db.applyBuyFill({ ticker: "NVDA", shares: 1, fillUsd: 100, stopLossJson: null, takeProfitJson: null, sourceRuleId: null });
    const pnl = db.applySellFill({ ticker: "NVDA", shares: 1, proceedsUsd: 90, ruleId: null, reason: "stop" });
    expect(pnl).toBeCloseTo(-10);
    expect(db.getPosition("NVDA")).toBeNull();
    expect(db.realizedTrades(10)).toHaveLength(1);
  });

  test("sell of more shares than held clamps", () => {
    const db = freshDb();
    db.applyBuyFill({ ticker: "NVDA", shares: 1, fillUsd: 100, stopLossJson: null, takeProfitJson: null, sourceRuleId: null });
    db.applySellFill({ ticker: "NVDA", shares: 5, proceedsUsd: 110, ruleId: null, reason: "x" });
    expect(db.getPosition("NVDA")).toBeNull();
  });
});

describe("daily state", () => {
  test("defaults and increments", () => {
    const db = freshDb();
    const d = db.getDailyState("2026-06-10");
    expect(d.orders_count).toBe(0);
    expect(d.day_start_equity).toBeNull();
    expect(db.incrementOrdersCount("2026-06-10")).toBe(1);
    expect(db.incrementOrdersCount("2026-06-10")).toBe(2);
    db.setDailyState("2026-06-10", { buys_frozen: 1, day_start_equity: 150 });
    const d2 = db.getDailyState("2026-06-10");
    expect(d2.buys_frozen).toBe(1);
    expect(d2.day_start_equity).toBe(150);
  });
});

describe("meta and costs", () => {
  test("meta roundtrip", () => {
    const db = freshDb();
    expect(db.getMeta("x")).toBeNull();
    db.setMeta("x", "1");
    expect(db.getMeta("x")).toBe("1");
    db.setMeta("x", "2");
    expect(db.getMetaNum("x")).toBe(2);
  });
  test("api cost aggregation", () => {
    const db = freshDb();
    db.addApiCost({ date: "2026-06-10", purpose: "planner", model: "m", inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 500, webSearches: 3, costUsd: 0.12 });
    db.addApiCost({ date: "2026-06-11", purpose: "planner", model: "m", inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 500, webSearches: 0, costUsd: 0.05 });
    expect(db.totalApiCost()).toBeCloseTo(0.17);
    expect(db.apiCostForDate("2026-06-10")).toBeCloseTo(0.12);
  });
});
